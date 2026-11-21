import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, RunOutput } from "../types.ts";

// package.json version on this commit is 1.32.0. npm's 1.32.0 tarball is an
// older gitHead, so the pin is the commit.
const NANOCODER_COMMIT = "31e58cf8f0aa38835f201dc62f71503e3ca76ed5";
const NANOCODER_URL = "https://github.com/Nano-Collective/nanocoder.git";

// parseToolCalls (source/tool-calling/tool-parser.ts) and resolveFilePath
// (source/utils/fs/path-validation.ts). The worker does the byte IO.
export const nanocoder: Adapter = {
  name: "nanocoder",
  run(input) {
    const checkout = ensureNanocoder();
    const tsx = path.join(packageRoot(), "node_modules", ".bin", "tsx");
    const worker = path.join(packageRoot(), "src/adapters/nanocoder-worker.ts");
    const child = spawnSync(
      tsx,
      ["--tsconfig", path.join(checkout, "tsconfig.json"), worker, checkout],
      {
        input: JSON.stringify({
          raw: input.raw,
          sandboxDir: input.sandboxDir,
        }),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (child.error) throw child.error;
    if (child.status !== 0) {
      const detail = (
        child.stderr ||
        child.stdout ||
        "nanocoder worker failed"
      ).split("\n")[0];
      throw new Error(detail ?? "nanocoder worker failed");
    }
    return Promise.resolve(readOutput(child.stdout));
  },
};

function ensureNanocoder(): string {
  const dir =
    process.env.GAUNTLET_NANOCODER ??
    path.join(packageRoot(), "third_party", "nanocoder");
  if (!existsSync(path.join(dir, ".git"))) {
    mkdirSync(path.dirname(dir), { recursive: true });
    git(["clone", "--filter=blob:none", NANOCODER_URL, dir]);
  }
  const head = git(["rev-parse", "HEAD"], dir).trim();
  if (head === NANOCODER_COMMIT) return dir;
  git(["fetch", "--depth", "1", "origin", NANOCODER_COMMIT], dir);
  git(["checkout", "--detach", NANOCODER_COMMIT], dir);
  return dir;
}

function git(args: readonly string[], cwd?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "git failed").trim();
    throw new Error(detail.split("\n")[0] ?? "git failed");
  }
  return result.stdout;
}

function readOutput(stdout: string): RunOutput {
  const lines = stdout.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.startsWith("{")) return JSON.parse(line) as RunOutput;
  }
  throw new Error("nanocoder worker returned no JSON");
}

function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 6; hop += 1) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("package root not found");
}
