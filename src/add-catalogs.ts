// Adds the PDFs in the catalogs folder to the existing knowledge base without re-crawling the
// website. Run it after adding, replacing or removing a catalog: `npm run add-catalogs`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshCatalogsInKnowledgeBase } from "./catalogs.ts";

await refreshCatalogsInKnowledgeBase(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
