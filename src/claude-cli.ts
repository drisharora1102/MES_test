// Finding and running the Claude Code CLI, so work runs on a Claude plan instead of an API key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findClaudeCli(): string | null {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  // The Claude Code extension for VS Code ships the CLI. Use the newest installed version.
  const extensions = path.join(os.homedir(), ".vscode", "extensions");
  if (!fs.existsSync(extensions)) return null;
  return (
    fs
      .readdirSync(extensions)
      .filter((name) => name.startsWith("anthropic.claude-code-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => path.join(extensions, name, "resources", "native-binary", exe))
      .find((file) => fs.existsSync(file)) ?? null
  );
}

/** Environment for the CLI without API credentials, so it signs in with the Claude plan. */
export function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}
