// Turns the catalog PDFs in the catalogs folder into knowledge-base documents, one per page,
// so an answer can point to the exact page. The chat server serves the PDFs at /catalogs/.
import fs from "node:fs/promises";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { catalogProductNames, type Doc } from "./kb.ts";

export async function readCatalogs(dir: string): Promise<Doc[]> {
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => /\.pdf$/i.test(f)).sort();
  const docs: Doc[] = [];
  for (const file of files) {
    const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(path.join(dir, file))));
    const { text: pages } = await extractText(pdf);
    const name = file.replace(/\.pdf$/i, "").replace(/\s*[-–]\s*Master.*$/i, "").trim();
    // A file of inner pages ("..._Inner Pages_2-99") starts at a later printed page number.
    const firstPage = Number(/Pages?_(\d+)-\d+/i.exec(file)?.[1] ?? 1);
    pages.forEach((raw, i) => {
      const text = raw.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();
      if (text.length < 40) return; // An image-only page has no text to search.
      const page = firstPage + i;
      const products = catalogProductNames(text);
      docs.push({
        type: "catalog",
        title: `${name}, page ${page}${products.length ? `: ${products.slice(0, 3).join(", ")}` : ""}`,
        url: `/catalogs/${encodeURIComponent(file)}#page=${i + 1}`,
        text: `From the ${name}, page ${page}.\n\n${text}`,
      });
    });
    console.log(`  ${file}: ${pages.length} pages`);
  }
  return docs;
}
