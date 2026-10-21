import fs from "node:fs/promises";

export type DocType = "product" | "collection" | "page" | "article" | "pdf";

export interface Doc {
  type: DocType;
  title: string;
  url: string;
  text: string;
}

export interface KnowledgeBase {
  source: string;
  builtAt: string;
  docs: Doc[];
}

const TYPE_ORDER: DocType[] = ["product", "collection", "page", "article", "pdf"];

export async function loadKnowledgeBase(file: string): Promise<KnowledgeBase> {
  return JSON.parse(await fs.readFile(file, "utf8")) as KnowledgeBase;
}

/**
 * The knowledge base as one prompt block. The output must be identical on every request
 * so the prompt cache keeps hitting: documents are sorted, and nothing per-request goes in.
 */
export function renderKnowledgeBase(kb: KnowledgeBase): string {
  const docs = [...kb.docs].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.url.localeCompare(b.url),
  );
  const body = docs.map((d) => renderDocument(d)).join("\n\n");
  return `<knowledge_base source="${attr(kb.source)}" collected="${collectedOn(kb)}">\n${body}\n</knowledge_base>`;
}

/**
 * Every product name, grouped by category: an overview of the whole catalog that is small
 * enough to send with every question. Each product appears once, under its most specific
 * collection. Links are left out to keep it small; they come with the matching pages.
 */
export function renderCatalog(kb: KnowledgeBase): string {
  const products = kb.docs.filter((d) => d.type === "product");
  const collectionsOf = new Map<Doc, string[]>();
  const collectionSize = new Map<string, number>();
  for (const d of products) {
    const collections = (/^Collections: (.*)$/m.exec(d.text)?.[1] ?? "")
      .split(", ")
      .filter((c) => c && !/^(All |Featured |New Indoor)/.test(c));
    collectionsOf.set(d, collections);
    for (const c of collections) collectionSize.set(c, (collectionSize.get(c) ?? 0) + 1);
  }
  const groups = new Map<string, string[]>();
  for (const d of products) {
    const [home = "Other"] = [...collectionsOf.get(d)!].sort(
      (a, b) => collectionSize.get(a)! - collectionSize.get(b)! || a.localeCompare(b),
    );
    groups.set(home, [...(groups.get(home) ?? []), d.title]);
  }
  const lines = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([collection, names]) => `${collection}: ${names.sort().join("; ")}`);
  return `<product_catalog products="${products.length}">\n${lines.join("\n")}\n</product_catalog>`;
}

/** Selected documents only, in the order given, each cut to at most `maxChars` characters. */
export function renderExcerpts(kb: KnowledgeBase, docs: Doc[], maxChars: number): string {
  const body = docs.map((d) => renderDocument({ ...d, text: documentsFirst(d.text) }, maxChars)).join("\n\n");
  return `<knowledge_base_excerpts source="${attr(kb.source)}" collected="${collectedOn(kb)}">\n${body}\n</knowledge_base_excerpts>`;
}

/** Moves a product's spec sheet and manual links to the top, so cutting a long page keeps them. */
function documentsFirst(text: string): string {
  const at = text.indexOf("\nDocuments:\n");
  return at === -1 ? text : `${text.slice(at + 1)}\n\n${text.slice(0, at)}`;
}

function renderDocument(d: Doc, maxChars = Infinity): string {
  const text = d.text.length > maxChars ? `${d.text.slice(0, maxChars)}\n[The rest of this document is not shown.]` : d.text;
  return (
    `<document type="${d.type}" title="${attr(d.title)}" url="${attr(d.url)}">\n` +
    `${text.replaceAll("</document>", "</ document>")}\n</document>`
  );
}

function attr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** Rough size: about 4 characters per token for English text. */
export function estimateTokens(characters: number): number {
  return Math.round(characters / 4);
}

export function countByType(kb: KnowledgeBase): Record<DocType, number> {
  const counts: Record<DocType, number> = { product: 0, collection: 0, page: 0, article: 0, pdf: 0 };
  for (const doc of kb.docs) counts[doc.type]++;
  return counts;
}

export function collectedOn(kb: KnowledgeBase): string {
  return new Date(kb.builtAt).toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
}

// ---------- Keyword search (used only when no Anthropic credentials are configured) ----------

export interface SearchHit {
  doc: Doc;
  score: number;
  snippet: string;
}

export interface SearchIndex {
  entries: { doc: Doc; counts: Map<string, number>; length: number }[];
  docFrequency: Map<string, number>;
  averageLength: number;
}

const STOP_WORDS = new Set(
  "a an and any are about be can do does for from have how i in is it me of on or our sell the there to we what which with you your".split(
    " ",
  ),
);
const TITLE_WEIGHT = 3;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP_WORDS.has(t)).map(stem);
}

/** Folds simple plurals together so "chargers" matches "charger". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function buildSearchIndex(kb: KnowledgeBase): SearchIndex {
  const docFrequency = new Map<string, number>();
  const entries = kb.docs.map((doc) => {
    const counts = new Map<string, number>();
    for (const term of tokenize(doc.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const term of tokenize(doc.title)) counts.set(term, (counts.get(term) ?? 0) + TITLE_WEIGHT);
    for (const term of counts.keys()) docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
    const length = [...counts.values()].reduce((sum, n) => sum + n, 0);
    return { doc, counts, length };
  });
  const averageLength = entries.reduce((sum, e) => sum + e.length, 0) / Math.max(entries.length, 1);
  return { entries, docFrequency, averageLength };
}

/** BM25 ranking: rewards rare query words and doesn't let long pages win on length alone. */
export function search(index: SearchIndex, query: string, limit = 5): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  const total = index.entries.length;
  const k1 = 1.2;
  const b = 0.75;
  const hits: SearchHit[] = [];
  for (const { doc, counts, length } of index.entries) {
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      const df = index.docFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / index.averageLength));
    }
    if (score > 0) hits.push({ doc, score, snippet: snippetAround(doc.text, terms) });
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, limit);
}

function snippetAround(text: string, terms: string[]): string {
  const match = terms.length ? new RegExp(`\\b(${terms.join("|")})`, "i").exec(text) : null;
  const start = Math.max(0, (match?.index ?? 0) - 80);
  const snippet = text.slice(start, start + 240).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${start + 240 < text.length ? "…" : ""}`;
}
