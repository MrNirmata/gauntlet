#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execAdapter, httpAdapter } from "./adapters/blackbox.ts";
import { adapters } from "./adapters/index.ts";
import type { BaselineComparison, BaselineData } from "./baseline.ts";
import { compareBaseline, readBaseline, writeBaseline } from "./baseline.ts";
import {
  formatDetails,
  formatJson,
  formatJUnit,
  formatList,
  formatListJson,
  formatRun,
  formatShow,
} from "./format.ts";
import { runAll } from "./run.ts";
import { scenarios } from "./scenarios/index.ts";
import type { Adapter, Category, RunOptions, Scenario } from "./types.ts";

const USAGE =
  "usage: gauntlet list [--json] | gauntlet show <id> | gauntlet run (--adapter <name-or-path> | --exec <command> | --http <url>) [--name <label>] [--timeout <ms>] [--scenario <id>] [--category <name>] [--json] [--verbose] [--junit <file>] [--baseline <file> | --update-baseline <file>] [--strict]\n";

const HELP = `Gauntlet feeds adversarial tool-call payloads to an adapter.

commands:
  gauntlet list [--json]     print every scenario
  gauntlet show <id>         print one scenario and the payloads it sends
  gauntlet run <target>      run the scenarios against an adapter
  gauntlet help              print this text
  gauntlet --version         print the version

run targets, exactly one:
  --adapter <name-or-path>   a built-in adapter, or a module that exports one
  --exec <command>           a shell command, run once per probe
  --http <url>               a URL that receives one POST per probe

run options:
  --scenario <id>            run only this scenario. Repeat it, or separate ids with commas
  --category <name>          run only this category. Repeat it, or separate names with commas
  --timeout <ms>             limit for one probe. The default is 10000
  --name <label>             adapter name in the report
  --json                     print the report as one JSON object
  --verbose                  add the payloads and outputs of every scenario that did not pass
  --junit <file>             also write the results as JUnit XML
  --baseline <file>          compare with a recorded run. Exit 1 only on a regression
  --update-baseline <file>   record this run and exit 0
  --strict                   with --baseline, count a new failing scenario as a regression

exit codes:
  0  every scenario passed or was not covered, or no scenario regressed
  1  a scenario failed, errored, or regressed
  2  the command line, the adapter, or a file was wrong
`;

const DEFAULT_TIMEOUT_MS = 10_000;

type RunMode =
  | { kind: "adapter"; spec: string }
  | { kind: "exec"; command: string }
  | { kind: "http"; url: string };

type RunFlags = {
  mode: RunMode;
  scenarios: readonly string[];
  categories: readonly string[];
  json: boolean;
  verbose: boolean;
  junit: string | undefined;
  timeoutMs: number;
  name: string | undefined;
  baseline: string | undefined;
  updateBaseline: string | undefined;
  strict: boolean;
};

export async function runCli(
  argv: readonly string[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-V") {
    stdout.write(`${gauntletVersion()}\n`);
    return 0;
  }
  if (command === "list") return listCommand(argv.slice(1), stdout, stderr);
  if (command === "show") return showCommand(argv.slice(1), stdout, stderr);
  if (command !== "run") {
    stderr.write(USAGE);
    return 2;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(HELP);
    return 0;
  }
  const flags = parseRunFlags(argv.slice(1));
  if ("error" in flags) {
    stderr.write(`${flags.error}\n`);
    return 2;
  }
  const adapter = await resolveRunAdapter(flags, stderr);
  if (!adapter) return 2;
  const selected = selectScenarios(flags.scenarios, flags.categories);
  if ("error" in selected) {
    stderr.write(`${selected.error}\n`);
    return 2;
  }
  let recorded: BaselineData | undefined;
  if (flags.baseline !== undefined) {
    const loaded = readBaseline(flags.baseline);
    if ("error" in loaded) {
      stderr.write(`${loaded.error}\n`);
      return 2;
    }
    recorded = loaded;
  }
  // --exec and --http enforce the limit themselves and kill what they
  // started. An in-process adapter gets the same limit from the runner.
  const options: RunOptions =
    flags.mode.kind === "adapter" ? { timeoutMs: flags.timeoutMs } : {};
  const results = await runAll(adapter, selected.scenarios, options);
  const version = gauntletVersion();
  const summary = recorded
    ? compareBaseline(
        recorded,
        results,
        scenarios.map((scenario) => scenario.id),
        flags.strict,
      )
    : undefined;
  if (flags.json) {
    stdout.write(
      formatJson(adapter.name, version, results, summary, {
        probes: flags.verbose,
      }),
    );
  } else {
    stdout.write(formatRun(adapter.name, results, summary));
    if (flags.verbose) {
      const details = formatDetails(results, scenarios);
      if (details.length > 0) stdout.write(`\n${details}`);
    }
  }
  if (summary) writeComparisonNotes(stderr, results, summary, flags.strict);
  if (flags.junit !== undefined) {
    const failure = writeReportFile(
      flags.junit,
      formatJUnit(adapter.name, results),
    );
    if (failure !== undefined) {
      stderr.write(`${failure}\n`);
      return 2;
    }
  }
  if (flags.updateBaseline !== undefined) {
    const failure = writeBaseline(
      flags.updateBaseline,
      version,
      adapter.name,
      results,
    );
    if (failure !== undefined) {
      stderr.write(`${failure}\n`);
      return 2;
    }
    return 0;
  }
  if (summary) return summary.regressions.length > 0 ? 1 : 0;
  const bad = results.some(
    (result) => result.status === "fail" || result.status === "error",
  );
  return bad ? 1 : 0;
}

function listCommand(
  argv: readonly string[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): number {
  const unknown = argv.find((token) => token !== "--json");
  if (unknown !== undefined) {
    stderr.write(`unknown argument ${unknown}\n`);
    return 2;
  }
  stdout.write(
    argv.includes("--json") ? formatListJson(scenarios) : formatList(scenarios),
  );
  return 0;
}

function showCommand(
  argv: readonly string[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): number {
  const id = argv[0];
  if (id === undefined || argv.length !== 1) {
    stderr.write("usage: gauntlet show <id>\n");
    return 2;
  }
  const scenario = scenarios.find((item) => item.id === id);
  if (!scenario) {
    stderr.write(`unknown scenario ${id}\n`);
    return 2;
  }
  stdout.write(formatShow(scenario));
  return 0;
}

function writeReportFile(file: string, text: string): string | undefined {
  try {
    writeFileSync(path.resolve(process.cwd(), file), text, "utf8");
  } catch (error) {
    return `could not write ${file}: ${errorLine(error)}`;
  }
  return undefined;
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
  let exec: string | undefined;
  let http: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let name: string | undefined;
  const scenarioIds: string[] = [];
  const categories: string[] = [];
  let json = false;
  let verbose = false;
  let junit: string | undefined;
  let baseline: string | undefined;
  let updateBaseline: string | undefined;
  let strict = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--strict") {
      strict = true;
      continue;
    }
    if (token === "--verbose") {
      verbose = true;
      continue;
    }
    if (
      token === "--adapter" ||
      token === "--exec" ||
      token === "--http" ||
      token === "--timeout" ||
      token === "--name" ||
      token === "--scenario" ||
      token === "--category" ||
      token === "--junit" ||
      token === "--baseline" ||
      token === "--update-baseline"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `missing ${token} value` };
      }
      if (token === "--timeout") {
        if (!/^[1-9]\d*$/.test(value)) return { error: "invalid --timeout" };
        timeoutMs = Number(value);
      } else if (token === "--name") {
        if (value.length === 0) return { error: "missing --name value" };
        name = value;
      } else if (token === "--adapter") adapter = value;
      else if (token === "--exec") exec = value;
      else if (token === "--http") http = value;
      else if (token === "--baseline") baseline = value;
      else if (token === "--update-baseline") updateBaseline = value;
      else if (token === "--junit") junit = value;
      else if (token === "--category") categories.push(...splitList(value));
      else scenarioIds.push(...splitList(value));
      index += 1;
      continue;
    }
    return { error: `unknown argument ${token}` };
  }
  const selected = [adapter, exec, http].filter(
    (item) => item !== undefined,
  ).length;
  if (selected === 0) {
    return { error: "missing --adapter, --exec, or --http" };
  }
  if (selected > 1) {
    return { error: "--adapter, --exec, and --http are mutually exclusive" };
  }
  if (baseline !== undefined && updateBaseline !== undefined) {
    return {
      error: "--baseline and --update-baseline are mutually exclusive",
    };
  }
  const shared = {
    scenarios: scenarioIds,
    categories,
    json,
    verbose,
    junit,
    timeoutMs,
    name,
    baseline,
    updateBaseline,
    strict,
  };
  if (exec !== undefined) {
    return { mode: { kind: "exec", command: exec }, ...shared };
  }
  if (http !== undefined) {
    return { mode: { kind: "http", url: http }, ...shared };
  }
  if (adapter === undefined) {
    return { error: "missing --adapter, --exec, or --http" };
  }
  return { mode: { kind: "adapter", spec: adapter }, ...shared };
}

async function resolveRunAdapter(
  flags: RunFlags,
  stderr: NodeJS.WritableStream,
): Promise<Adapter | undefined> {
  if (flags.mode.kind === "exec") {
    return execAdapter(
      flags.mode.command,
      flags.timeoutMs,
      flags.name ?? `exec:${flags.mode.command}`,
    );
  }
  if (flags.mode.kind === "http") {
    return httpAdapter(
      flags.mode.url,
      flags.timeoutMs,
      flags.name ?? `http:${flags.mode.url}`,
    );
  }
  const adapter = await resolveAdapter(flags.mode.spec, stderr);
  if (!adapter || flags.name === undefined) return adapter;
  return { name: flags.name, run: (input) => adapter.run(input) };
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

function writeComparisonNotes(
  stderr: NodeJS.WritableStream,
  results: readonly { id: string; status: string }[],
  summary: BaselineComparison,
  strict: boolean,
): void {
  for (const id of summary.removed) {
    stderr.write(
      `note: ignoring baseline scenario ${id}; it is not in this version\n`,
    );
  }
  if (strict) return;
  const status = new Map(results.map((result) => [result.id, result.status]));
  for (const id of summary.added) {
    const current = status.get(id);
    if (current === "fail" || current === "error") {
      stderr.write(`warning: new scenario ${id} is ${current}\n`);
    }
  }
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Ids and categories add up. The report keeps the order of the full list.
function selectScenarios(
  ids: readonly string[],
  categories: readonly string[],
): { scenarios: readonly Scenario[] } | { error: string } {
  if (ids.length === 0 && categories.length === 0) return { scenarios };
  for (const id of ids) {
    if (!scenarios.some((scenario) => scenario.id === id)) {
      return { error: `unknown scenario ${id}` };
    }
  }
  const known = new Set<Category>(scenarios.map((item) => item.category));
  for (const category of categories) {
    if (![...known].some((name) => name === category)) {
      return {
        error: `unknown category ${category}; one of ${[...known].join(", ")}`,
      };
    }
  }
  return {
    scenarios: scenarios.filter(
      (scenario) =>
        ids.includes(scenario.id) || categories.includes(scenario.category),
    ),
  };
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
