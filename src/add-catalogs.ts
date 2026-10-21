// Adds the PDFs in the catalogs folder to the existing knowledge base without re-crawling the
// website. Run it after adding, replacing or removing a catalog: `npm run add-catalogs`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalogs } from "./catalogs.ts";
import { countByType, loadKnowledgeBase, saveKnowledgeBase } from "./kb.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

const kb = await loadKnowledgeBase(path.join(dataDir, "kb.json"));
console.log("Reading catalogs:");
const catalogPages = await readCatalogs(path.join(root, "catalogs"));
kb.docs = [...kb.docs.filter((d) => d.type !== "catalog"), ...catalogPages];
await saveKnowledgeBase(kb, dataDir);
const counts = countByType(kb);
console.log(`Knowledge base now has ${kb.docs.length} documents, ${counts.catalog} of them catalog pages. Restart the chat server to use them.`);
