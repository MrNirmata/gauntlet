#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapters } from "./adapters/index.ts";
import { formatJson, formatList, formatRun } from "./format.ts";
import { runAll } from "./run.ts";
import { scenarios } from "./scenarios.ts";
import type { Adapter, Scenario } from "./types.ts";

const USAGE =
  "usage: gauntlet list | gauntlet run --adapter <name-or-path> [--scenario <id>] [--json]\n";

type RunFlags = {
  adapter: string;
  scenario: string | undefined;
  json: boolean;
};

export async function runCli(
  argv: readonly string[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const command = argv[0];
  if (command === "list") {
    stdout.write(formatList(scenarios));
    return 0;
  }
  if (command !== "run") {
    stderr.write(USAGE);
    return 2;
  }
  const flags = parseRunFlags(argv.slice(1));
  if ("error" in flags) {
    stderr.write(`${flags.error}\n`);
    return 2;
  }
  const adapter = await resolveAdapter(flags.adapter, stderr);
  if (!adapter) return 2;
  const selected = selectScenarios(flags.scenario);
  if ("error" in selected) {
    stderr.write(`${selected.error}\n`);
    return 2;
  }
  const results = await runAll(adapter, selected.scenarios);
  stdout.write(
    flags.json
      ? formatJson(adapter.name, gauntletVersion(), results)
      : formatRun(adapter.name, results),
  );
  const bad = results.some(
    (result) => result.status === "fail" || result.status === "error",
  );
  return bad ? 1 : 0;
}

function gauntletVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    throw new Error("package.json missing version");
  }
  return parsed.version;
}

function parseRunFlags(argv: readonly string[]): RunFlags | { error: string } {
  let adapter: string | undefined;
  let scenario: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--adapter" || token === "--scenario") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `missing ${token} value` };
      }
      if (token === "--adapter") adapter = value;
      else scenario = value;
      index += 1;
      continue;
    }
    return { error: `unknown argument ${token}` };
  }
  if (adapter === undefined) return { error: "missing --adapter" };
  return { adapter, scenario, json };
}

async function resolveAdapter(
  spec: string,
  stderr: NodeJS.WritableStream,
): Promise<Adapter | undefined> {
  if (!isAdapterPath(spec)) {
    const adapter = adapters.find((item) => item.name === spec);
    if (!adapter) stderr.write(`unknown adapter ${spec}\n`);
    return adapter;
  }
  return loadAdapterFile(spec, stderr);
}

function isAdapterPath(spec: string): boolean {
  return (
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.endsWith(".js") ||
    spec.endsWith(".mjs") ||
    spec.endsWith(".ts") ||
    spec.endsWith(".mts")
  );
}

async function loadAdapterFile(
  spec: string,
  stderr: NodeJS.WritableStream,
): Promise<Adapter | undefined> {
  const resolved = path.resolve(process.cwd(), spec);
  if (!existsSync(resolved)) {
    stderr.write(`adapter file not found: ${spec}\n`);
    return undefined;
  }
  try {
    const imported: unknown = await import(pathToFileURL(resolved).href);
    const adapter = adapterFromModule(imported);
    if (!adapter) {
      stderr.write(`invalid adapter ${spec}\n`);
      return undefined;
    }
    return adapter;
  } catch (error) {
    stderr.write(`${adapterLoadError(spec, resolved, error)}\n`);
    return undefined;
  }
}

function adapterFromModule(mod: unknown): Adapter | undefined {
  if (typeof mod !== "object" || mod === null) return undefined;
  if ("default" in mod && isAdapter(mod.default)) return mod.default;
  if ("adapter" in mod && isAdapter(mod.adapter)) return mod.adapter;
  return undefined;
}

function isAdapter(value: unknown): value is Adapter {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || !("run" in value)) return false;
  return (
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.run === "function"
  );
}

function adapterLoadError(
  spec: string,
  resolved: string,
  error: unknown,
): string {
  if (isTypeScriptFile(resolved) && isTypeStripFailure(error)) {
    return `could not load adapter ${spec}: compile it to .js or run through tsx`;
  }
  return `could not load adapter ${spec}: ${errorLine(error)}`;
}

function isTypeScriptFile(file: string): boolean {
  return file.endsWith(".ts") || file.endsWith(".mts");
}

function isTypeStripFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (
    error.code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    error.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"
  );
}

function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n")[0];
  return line !== undefined && line.length > 0 ? line : "unknown error";
}

function selectScenarios(
  id: string | undefined,
): { scenarios: readonly Scenario[] } | { error: string } {
  if (id === undefined) return { scenarios };
  const match = scenarios.find((scenario) => scenario.id === id);
  if (!match) return { error: `unknown scenario ${id}` };
  return { scenarios: [match] };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const code = await runCli(
    process.argv.slice(2),
    process.stdout,
    process.stderr,
  );
  process.exit(code);
}
