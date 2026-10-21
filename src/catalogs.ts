// Turns the catalog PDFs in the catalogs folder into knowledge-base documents, one per page,
// so an answer can point to the exact page. The chat server serves the PDFs at /catalogs/.
// A page's text misses what is only drawn (certification logos, feature icons, table layout),
// so `npm run describe-catalogs` saves a description of each page image in data/catalog-pages/,
// which is added to that page here.
import fs from "node:fs/promises";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { catalogProductNames, countByType, loadKnowledgeBase, saveKnowledgeBase, type Doc } from "./kb.ts";

export interface CatalogFile {
  file: string;
  /** The catalog's name, such as "2026 MES Catalog". */
  name: string;
  /** The printed page number of the PDF's first page. */
  firstPage: number;
}

export async function listCatalogs(dir: string): Promise<CatalogFile[]> {
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => /\.pdf$/i.test(f)).sort();
  return files.map((file) => ({
    file,
    name: file.replace(/\.pdf$/i, "").replace(/\s*[-–]\s*Master.*$/i, "").trim(),
    // A file of inner pages ("..._Inner Pages_2-99") starts at a later printed page number.
    firstPage: Number(/Pages?_(\d+)-\d+/i.exec(file)?.[1] ?? 1),
  }));
}

/** Where the description of one page's image is saved. */
export function pageDescriptionFile(descriptionsDir: string, catalog: CatalogFile, page: number): string {
  return path.join(descriptionsDir, `${catalog.name} - page ${page}.md`);
}

export async function readCatalogs(dir: string, descriptionsDir: string): Promise<Doc[]> {
  const docs: Doc[] = [];
  for (const catalog of await listCatalogs(dir)) {
    const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(path.join(dir, catalog.file))));
    const { text: pages } = await extractText(pdf);
    let described = 0;
    for (const [i, raw] of pages.entries()) {
      const page = catalog.firstPage + i;
      const text = raw.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();
      const description = await fs.readFile(pageDescriptionFile(descriptionsDir, catalog, page), "utf8").catch(() => "");
      if (description) described++;
      if (text.length < 40 && !description) continue; // An image-only page with nothing to search.
      const products = catalogProductNames(`${text}\n${description}`);
      const parts = [`From the ${catalog.name}, page ${page}.`];
      if (description) parts.push(`What the page shows, read from the page image:\n${description.trim()}`);
      parts.push(description ? `The page's raw text:\n${text}` : text);
      docs.push({
        type: "catalog",
        title: `${catalog.name}, page ${page}${products.length ? `: ${products.slice(0, 3).join(", ")}` : ""}`,
        url: `/catalogs/${encodeURIComponent(catalog.file)}#page=${i + 1}`,
        text: parts.join("\n\n"),
      });
    }
    console.log(`  ${catalog.file}: ${pages.length} pages, ${described} with an image description`);
  }
  return docs;
}

/** Replaces the catalog pages in data/kb.json with the current catalogs and descriptions. */
export async function refreshCatalogsInKnowledgeBase(root: string): Promise<void> {
  const dataDir = path.join(root, "data");
  const kb = await loadKnowledgeBase(path.join(dataDir, "kb.json"));
  console.log("Reading catalogs:");
  const catalogPages = await readCatalogs(path.join(root, "catalogs"), path.join(dataDir, "catalog-pages"));
  kb.docs = [...kb.docs.filter((d) => d.type !== "catalog"), ...catalogPages];
  await saveKnowledgeBase(kb, dataDir);
  console.log(
    `Knowledge base now has ${kb.docs.length} documents, ${countByType(kb).catalog} of them catalog pages. ` +
      "Restart the chat server to use them.",
  );
}
