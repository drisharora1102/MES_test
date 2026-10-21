// Has Claude look at catalog pages as images and write down what the text extraction misses:
// certification logos, feature icons, ordering tables, compatible sensors and dimensions.
// It runs through Claude Code on your Claude plan, saves each description in data/catalog-pages/,
// then updates the knowledge base. Pages that already have a description are skipped, so an
// interrupted run picks up where it stopped.
//
//   npm run describe-catalogs -- 22 23    printed page numbers
//   npm run describe-catalogs             every page
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getDocumentProxy, renderPageAsImage } from "unpdf";
import { listCatalogs, pageDescriptionFile, refreshCatalogsInKnowledgeBase } from "./catalogs.ts";
import { cliEnv, findClaudeCli } from "./claude-cli.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogsDir = path.join(root, "catalogs");
const descriptionsDir = path.join(root, "data", "catalog-pages");
// Wide enough for the small print in logos and tables to stay readable.
const IMAGE_WIDTH = 1400;

const SYSTEM_PROMPT =
  "You read pages of a commercial LED lighting catalog and write down, as plain text, what a sales rep needs from them. " +
  "Write only what is printed on the page. If a logo or number is hard to read, say so instead of guessing.";

const INSTRUCTIONS = `This is page {page} of the {catalog}. Write down, under these headings and skipping any the page doesn't have:

Products: each product name exactly as printed.
Certifications: every certification logo shown (for example UL, cULus, ETL, DLC Standard, DLC Premium, DLC NLC5, Energy Star, FCC, DarkSky), for each product if they differ.
Features shown as icons: for example IP rating, 0-10V dimming, sensor ready (and which type), CCT or power selectable, surge protection, high lumen.
Ordering table: one line per ordering code, with every column (DLC ID, watts, CCT, lumens per watt, total lumens, voltage, color and any others). Keep each wattage with its lumen value.
Compatible sensors and controls: brand and code for each.
Dimensions and mounting: anything shown in drawings or notes.
Other: anything else printed that a sales rep would need.

No introduction or summary.`;

const requested = process.argv.slice(2).map(Number).filter(Number.isInteger);
const cli = findClaudeCli();
if (!cli) {
  console.error("Claude Code wasn't found. Set CLAUDE_CLI in .env to its path.");
  process.exit(1);
}
const workDir = path.join(os.tmpdir(), "maverick-kb-chat");
await fs.mkdir(workDir, { recursive: true });
await fs.mkdir(descriptionsDir, { recursive: true });

let written = 0;
for (const catalog of await listCatalogs(catalogsDir)) {
  const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(path.join(catalogsDir, catalog.file))));
  for (let pdfPage = 1; pdfPage <= pdf.numPages; pdfPage++) {
    const page = catalog.firstPage + pdfPage - 1;
    if (requested.length > 0 && !requested.includes(page)) continue;
    const outFile = pageDescriptionFile(descriptionsDir, catalog, page);
    if (await fs.stat(outFile).catch(() => null)) continue;
    const started = Date.now();
    const png = await renderPageAsImage(pdf, pdfPage, {
      canvasImport: () => import("@napi-rs/canvas"),
      width: IMAGE_WIDTH,
    });
    const instructions = INSTRUCTIONS.replace("{page}", String(page)).replace("{catalog}", catalog.name);
    const description = await describeImage(Buffer.from(png).toString("base64"), instructions);
    await fs.writeFile(outFile, `${description.trim()}\n`);
    written++;
    console.log(`  ${catalog.name}, page ${page}: described in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
}
console.log(`Described ${written} page(s).`);
if (written > 0) await refreshCatalogsInKnowledgeBase(root);

/** Sends one image and its instructions to Claude Code and returns the reply. */
async function describeImage(pngBase64: string, instructions: string): Promise<string> {
  const child = spawn(
    cli!,
    [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--system-prompt",
      SYSTEM_PROMPT,
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "local",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--effort",
      "medium",
    ],
    { cwd: workDir, env: cliEnv(), windowsHide: true },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
        { type: "text", text: instructions },
      ],
    },
    parent_tool_use_id: null,
    session_id: "",
  };
  child.stdin.end(`${JSON.stringify(message)}\n`);
  for await (const line of readline.createInterface({ input: child.stdout })) {
    let event: { type?: string; is_error?: boolean; result?: string; rate_limit_info?: { status?: string } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected") {
      throw new Error("Your Claude plan's usage limit is reached. Run this again after it resets; finished pages are kept.");
    }
    if (event.type === "result") {
      if (event.is_error || !event.result) throw new Error(event.result || "Claude Code returned no description");
      return event.result;
    }
  }
  throw new Error(`Claude Code stopped without a result. ${stderr.slice(-500)}`);
}
