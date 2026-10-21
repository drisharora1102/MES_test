// Builds the knowledge base from the public parts of maverickled.com: the product feed and
// product pages, collections, information pages, blog articles, and the PDFs they link to
// (spec sheets, manuals, the catalog). Writes data/kb.json for the chat server and
// data/kb.md for people to read. Fetches only paths robots.txt allows, one request at a time.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { extractText, getDocumentProxy } from "unpdf";
import { collectedOn, countByType, estimateTokens, type Doc, type KnowledgeBase } from "./kb.ts";

const SITE = "https://maverickled.com";
const USER_AGENT = "MaverickKB-Test/0.1 (internal knowledge-base prototype)";
const REQUEST_GAP_MS = 500;
const MAX_PDF_BYTES = 80 * 1024 * 1024;
const MAX_PDF_CHARS = 300_000;
// Shopify's standard policy pages; any the store doesn't have are skipped.
const POLICY_PATHS = [
  "/policies/privacy-policy",
  "/policies/refund-policy",
  "/policies/shipping-policy",
  "/policies/terms-of-service",
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const cacheDir = path.join(dataDir, "cache");
const warnings: string[] = [];

// ---------- HTTP ----------

let lastRequestAt = 0;

async function get(url: string): Promise<Response | null> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await res.body?.cancel();
        await sleep((Number(res.headers.get("retry-after")) || 2 ** attempt) * 1000);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status !== 404) warn(`HTTP ${res.status} for ${url}`);
        return null;
      }
      return res;
    } catch (err) {
      if (attempt < 4) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      warn(`Could not fetch ${url}: ${(err as Error).message}`);
      return null;
    }
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await get(url);
  return res ? ((await res.json()) as T) : null;
}

async function getText(url: string): Promise<string | null> {
  const res = await get(url);
  return res ? res.text() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function warn(message: string): void {
  warnings.push(message);
  console.warn(`\n  ! ${message}`);
}

function progress(done: number, total: number, label: string): void {
  process.stdout.write(`\r  ${label}: ${done}/${total}${done === total ? "\n" : ""}`);
}

// ---------- HTML ----------

const NOISE =
  "script, style, noscript, svg, template, iframe, form, button, select, input, nav, header, footer, " +
  "[hidden], [aria-hidden='true'], .visually-hidden";
const BLOCKS = "p, div, section, article, li, tr, h1, h2, h3, h4, h5, h6, dt, dd, blockquote, summary, table, ul, ol";

/** Plain text of an HTML fragment, keeping paragraph breaks, list bullets and table cells. */
function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $(NOISE).remove();
  $("br").replaceWith("\n");
  $("li").prepend("- ");
  $("td, th").append(" | ");
  $(BLOCKS).append("\n");
  return tidy($.root().text());
}

function tidy(text: string): string {
  return text
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Link {
  url: string;
  label: string;
}

interface Page {
  title: string;
  text: string;
  /** Links in the main content. */
  mainLinks: Link[];
  /** Links anywhere on the page, menus and footer included. */
  allLinks: Link[];
}

function parsePage(html: string, pageUrl: string): Page {
  const $ = cheerio.load(html);
  const scope = $("main").length ? "main" : "body";
  const linksIn = (selector: string): Link[] =>
    $(selector)
      .find("a[href]")
      .map((_, a) => ({ url: absolute($(a).attr("href") ?? "", pageUrl), label: tidy($(a).text()) }))
      .get()
      .filter((link) => link.url !== "");
  const title = tidy($('meta[property="og:title"]').attr("content") ?? $("title").text());
  return {
    title,
    text: htmlToText($(scope).html() ?? ""),
    mainLinks: linksIn(scope),
    allLinks: linksIn("body"),
  };
}

function linksInFragment(html: string, baseUrl: string): Link[] {
  const $ = cheerio.load(html);
  return $("a[href]")
    .map((_, a) => ({ url: absolute($(a).attr("href") ?? "", baseUrl), label: tidy($(a).text()) }))
    .get()
    .filter((link) => link.url !== "");
}

function absolute(href: string, base: string): string {
  try {
    const url = new URL(href, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Same-site pages worth reading: information pages, blog articles and policies. */
function crawlable(url: string): string | null {
  const u = new URL(url);
  if (u.hostname !== new URL(SITE).hostname) return null;
  const pathname = u.pathname.replace(/\/+$/, "");
  const wanted =
    /^\/pages\/[^/]+$/.test(pathname) ||
    /^\/blogs\/[^/]+\/[^/]+$/.test(pathname) ||
    /^\/policies\/[^/]+$/.test(pathname);
  return wanted ? SITE + pathname : null;
}

// ---------- PDFs ----------

interface PdfRef {
  url: string;
  labels: Set<string>;
  sources: Set<string>;
}

const pdfs = new Map<string, PdfRef>();

function isPdfLink(url: string): boolean {
  const u = new URL(url);
  // SharePoint shares PDFs (such as the catalog) under /:b:/ links with no .pdf extension.
  return /\.pdf$/i.test(u.pathname) || (u.hostname.endsWith(".sharepoint.com") && u.pathname.includes("/:b:/"));
}

function notePdf(link: Link, sourceTitle: string): void {
  const ref = pdfs.get(link.url) ?? { url: link.url, labels: new Set<string>(), sources: new Set<string>() };
  if (link.label) ref.labels.add(link.label);
  ref.sources.add(sourceTitle);
  pdfs.set(link.url, ref);
}

/** Share links need a parameter to return the file itself instead of a viewer page. */
function downloadUrl(url: string): string {
  const u = new URL(url);
  if (u.hostname.endsWith("dropbox.com")) u.searchParams.set("dl", "1");
  if (u.hostname.endsWith(".sharepoint.com")) u.searchParams.set("download", "1");
  return u.toString();
}

async function pdfText(url: string): Promise<string | null> {
  const cacheFile = path.join(cacheDir, `${crypto.createHash("sha1").update(url).digest("hex")}.pdf`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(cacheFile));
  } catch {
    const res = await get(downloadUrl(url));
    if (!res) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_PDF_BYTES) {
      await res.body?.cancel();
      warn(`Skipped a PDF over ${MAX_PDF_BYTES / 1024 / 1024} MB: ${url}`);
      return null;
    }
    bytes = new Uint8Array(await res.arrayBuffer());
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      warn(`Not a PDF (got ${res.headers.get("content-type") ?? "unknown type"}), skipped: ${url}`);
      return null;
    }
    await fs.writeFile(cacheFile, bytes);
  }
  try {
    const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
    const clean = tidy(text);
    if (clean.length <= MAX_PDF_CHARS) return clean;
    warn(`Kept the first ${MAX_PDF_CHARS.toLocaleString()} of ${clean.length.toLocaleString()} characters of ${url}`);
    return `${clean.slice(0, MAX_PDF_CHARS)}\n[Truncated: the rest of this PDF is not in the knowledge base.]`;
  } catch (err) {
    warn(`Could not read PDF ${url}: ${(err as Error).message}`);
    return null;
  }
}

// ---------- Shopify feeds ----------

interface ShopifyProduct {
  title: string;
  handle: string;
  body_html: string | null;
  vendor: string;
  product_type: string;
  tags: string[];
  options: { name: string; values: string[] }[];
  variants: { sku: string | null }[];
}

interface ShopifyCollection {
  title: string;
  handle: string;
  description: string | null;
  products_count: number;
}

const PAGE_SIZE = 250;

async function fetchPaged<T>(base: string, key: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 40; page++) {
    const data = await getJson<Record<string, T[] | undefined>>(`${base}?limit=${PAGE_SIZE}&page=${page}`);
    const batch = data?.[key] ?? [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return items;
}

// ---------- Crawl steps ----------

async function crawlCollections(): Promise<{ docs: Doc[]; byProduct: Map<string, string[]> }> {
  const collections = (await fetchPaged<ShopifyCollection>(`${SITE}/collections.json`, "collections")).filter(
    (c) => c.products_count > 0,
  );
  const byProduct = new Map<string, string[]>();
  const docs: Doc[] = [];
  for (const [i, c] of collections.entries()) {
    const products = await fetchPaged<{ title: string; handle: string }>(
      `${SITE}/collections/${c.handle}/products.json`,
      "products",
    );
    for (const p of products) byProduct.set(p.handle, [...(byProduct.get(p.handle) ?? []), c.title]);
    const lines = [
      htmlToText(c.description ?? ""),
      "",
      `Products in this collection (${products.length}):`,
      ...products.map((p) => `- ${p.title}: ${SITE}/products/${p.handle}`),
    ];
    docs.push({ type: "collection", title: c.title, url: `${SITE}/collections/${c.handle}`, text: tidy(lines.join("\n")) });
    progress(i + 1, collections.length, "Collections");
  }
  return { docs, byProduct };
}

async function crawlProducts(collectionsByProduct: Map<string, string[]>): Promise<Doc[]> {
  const products = await fetchPaged<ShopifyProduct>(`${SITE}/products.json`, "products");
  const docs: Doc[] = [];
  for (const [i, p] of products.entries()) {
    const url = `${SITE}/products/${p.handle}`;
    const html = await getText(url);
    const page = html ? parsePage(html, url) : null;
    const documents: Link[] = [];
    for (const link of [...(page?.mainLinks ?? []), ...linksInFragment(p.body_html ?? "", url)]) {
      if (isPdfLink(link.url) && !documents.some((d) => d.url === link.url)) documents.push(link);
    }
    for (const link of documents) notePdf(link, p.title);
    docs.push({
      type: "product",
      title: p.title,
      url,
      text: productText(p, collectionsByProduct.get(p.handle) ?? [], page?.text ?? "", documents),
    });
    progress(i + 1, products.length, "Products");
  }
  return docs;
}

function productText(p: ShopifyProduct, collections: string[], pageText: string, documents: Link[]): string {
  const lines = [`Brand: ${p.vendor}`];
  if (p.product_type) lines.push(`Product type: ${p.product_type}`);
  if (collections.length) lines.push(`Collections: ${collections.join(", ")}`);
  if (p.tags.length) lines.push(`Tags: ${p.tags.join(", ")}`);
  for (const option of p.options) {
    // Shopify gives single-variant products a placeholder "Title" option.
    if (option.name !== "Title") lines.push(`${option.name} options: ${option.values.join(", ")}`);
  }
  const skus = p.variants.map((v) => v.sku).filter(Boolean);
  if (skus.length) lines.push(`SKUs: ${skus.join(", ")}`);
  const description = htmlToText(p.body_html ?? "");
  if (pageText) lines.push("", "Product page:", pageText);
  if (description && !pageText.includes(description.slice(0, 80))) lines.push("", "Description:", description);
  if (documents.length) {
    lines.push("", "Documents:", ...documents.map((d) => `- ${d.label || "PDF"}: ${d.url}`));
  }
  return lines.join("\n");
}

async function crawlPages(): Promise<Doc[]> {
  const articleSitemap = await getText(`${SITE}/sitemap_articles_1.xml`);
  const articleUrls = [...(articleSitemap ?? "").matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => crawlable(m[1].replaceAll("&amp;", "&")))
    .filter((url): url is string => url !== null);
  const queue = [`${SITE}/`, ...POLICY_PATHS.map((p) => SITE + p), ...articleUrls];
  const seen = new Set<string>();
  const seenText = new Set<string>();
  const docs: Doc[] = [];
  while (queue.length > 0 && seen.size < 300) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const html = await getText(url);
    if (!html) continue;
    const page = parsePage(html, url);
    for (const link of page.allLinks) {
      if (isPdfLink(link.url)) {
        notePdf(link, page.title);
        continue;
      }
      const next = crawlable(link.url);
      if (next && !seen.has(next)) queue.push(next);
    }
    // The same article is often published in more than one blog; keep one copy.
    const fingerprint = crypto.createHash("sha1").update(page.text).digest("hex");
    if (page.text.length < 40 || seenText.has(fingerprint)) continue;
    seenText.add(fingerprint);
    const type = new URL(url).pathname.startsWith("/blogs/") ? "article" : "page";
    docs.push({ type, title: page.title, url, text: page.text });
    process.stdout.write(`\r  Pages and articles: ${docs.length}`);
  }
  process.stdout.write("\n");
  return docs;
}

async function crawlPdfs(): Promise<Doc[]> {
  await fs.mkdir(cacheDir, { recursive: true });
  const refs = [...pdfs.values()].sort((a, b) => a.url.localeCompare(b.url));
  const docs: Doc[] = [];
  for (const [i, ref] of refs.entries()) {
    const text = await pdfText(ref.url);
    progress(i + 1, refs.length, "PDFs");
    if (text === null) continue;
    const sources = [...ref.sources];
    docs.push({
      type: "pdf",
      title: `${pdfName(ref)} (from ${sources.slice(0, 3).join(", ")}${sources.length > 3 ? " and others" : ""})`,
      url: ref.url,
      text: `Linked from: ${sources.join("; ")}\n\n${text || "(This PDF has no extractable text; it is probably scanned images.)"}`,
    });
  }
  return docs;
}

function pdfName(ref: PdfRef): string {
  const label = [...ref.labels].find((l) => !/^(click here.*|here|view|download|open|pdf)$/i.test(l));
  if (label) return label;
  const file = decodeURIComponent(new URL(ref.url).pathname.split("/").pop() ?? "");
  return /\.pdf$/i.test(file) ? file.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ") : "PDF document";
}

// ---------- Output ----------

function toMarkdown(kb: KnowledgeBase): string {
  const sections: [Doc["type"], string][] = [
    ["product", "Products"],
    ["collection", "Collections"],
    ["page", "Pages"],
    ["article", "Articles"],
    ["pdf", "PDF documents"],
  ];
  const parts = [`# Maverick LED knowledge base\n\nSource: ${kb.source}, collected ${collectedOn(kb)}.`];
  for (const [type, heading] of sections) {
    const docs = kb.docs.filter((d) => d.type === type);
    parts.push(`## ${heading} (${docs.length})`, ...docs.map((d) => `### ${d.title}\n\n${d.url}\n\n${d.text}`));
  }
  return `${parts.join("\n\n")}\n`;
}

async function main(): Promise<void> {
  console.log(`Building the knowledge base from ${SITE}`);
  await fs.mkdir(dataDir, { recursive: true });
  const collections = await crawlCollections();
  const products = await crawlProducts(collections.byProduct);
  const pages = await crawlPages();
  const pdfDocs = await crawlPdfs();

  const kb: KnowledgeBase = {
    source: SITE,
    builtAt: new Date().toISOString(),
    docs: [...products, ...collections.docs, ...pages, ...pdfDocs],
  };
  await fs.writeFile(path.join(dataDir, "kb.json"), JSON.stringify(kb, null, 1));
  await fs.writeFile(path.join(dataDir, "kb.md"), toMarkdown(kb));

  const counts = countByType(kb);
  const chars = kb.docs.reduce((sum, d) => sum + d.text.length, 0);
  console.log(
    `\nWrote data/kb.json and data/kb.md: ${kb.docs.length} documents ` +
      `(${counts.product} products, ${counts.collection} collections, ${counts.page} pages, ` +
      `${counts.article} articles, ${counts.pdf} PDFs), about ${estimateTokens(chars).toLocaleString()} tokens.`,
  );
  if (warnings.length) console.log(`${warnings.length} warning(s):\n${warnings.map((w) => `  - ${w}`).join("\n")}`);
}

await main();
