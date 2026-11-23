#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execAdapter, httpAdapter } from "./adapters/blackbox.ts";
import { adapters } from "./adapters/index.ts";
import { mcpAdapter } from "./adapters/mcp.ts";
import type { BaselineComparison, BaselineData } from "./baseline.ts";
import { compareBaseline, readBaseline, writeBaseline } from "./baseline.ts";
import { runCleanups } from "./cleanup.ts";
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
import { formatSarif } from "./sarif.ts";
import { formatScan, formatScanJson, scanTotals } from "./scan/report.ts";
import { type ScanReport, ScanUsageError, scanMcp } from "./scan/scan.ts";
import { scenarios } from "./scenarios/index.ts";
import { printable } from "./text.ts";
import type { Adapter, Category, RunOptions, Scenario, Tier } from "./types.ts";

const USAGE =
  "usage: gauntlet list [--json] | gauntlet show <id> | gauntlet run (--adapter <name-or-path> | --exec <command> | --http <url> | --mcp <command>) [options] | gauntlet scan --mcp <command> [options]. gauntlet help lists the options.\n";

const HELP = `Gauntlet feeds adversarial tool-call payloads to an adapter.

commands:
  gauntlet list [--json]     print every scenario
  gauntlet show <id>         print one scenario and the payloads it sends
  gauntlet run <target>      run the scenarios against an adapter
  gauntlet scan --mcp <cmd>  call every tool of an MCP server with arguments made
                             from its own schemas, and report what it did
  gauntlet help              print this text
  gauntlet --version         print the version

run targets, exactly one:
  --adapter <name-or-path>   a built-in adapter, or a module that exports one
  --exec <command>           a shell command, run once per probe
  --http <url>               a URL that receives one POST per probe
  --mcp <command>            an MCP server on stdio, started once per scenario in the
                             scenario's directory. {workspace} in the command is that
                             directory, and {cwd} is the one gauntlet was started in

what the target is given:
  --structured               send each probe as a parsed call, for a target that never
                             reads raw model text. --mcp always does
  --tool <ours>=<theirs>     with --mcp, the server's name for read_file or write_file
  --arg <ours>=<theirs>      with --mcp, the server's name for the path or content argument

which scenarios run:
  --scenario <id>            run only this scenario. Repeat it, or separate ids with commas
  --category <name>          run only this category. Repeat it, or separate names with commas
  --tier <name>              run only safety or only robustness scenarios

reports:
  --json                     print the report as one JSON object
  --verbose                  add the payloads and outputs of every scenario that did not pass
  --junit <file>             also write the results as JUnit XML
  --sarif <file>             also write the results as SARIF 2.1.0
  --sarif-location <path>    the file a SARIF viewer opens for a failure
  --name <label>             adapter name in the report

what fails the run:
  --fail-on <tier>           any, safety, or robustness. The default is any
  --baseline <file>          compare with a recorded run. Exit 1 only on a regression
  --update-baseline <file>   record this run and exit 0
  --strict                   with --baseline, count a new failing scenario as a regression
  --timeout <ms>             limit for one probe. The default is 10000

scan options:
  --tool <name>              scan only this tool. Repeat it, or separate names with commas
  --skip <name>              leave this tool out
  --plan                     list what would be called and why, and call nothing
  --destructive              also call tools marked or named as removing, sending, or
                             spending. Without it they are left alone
  --env <NAME[=value]>       give the server this variable. It gets PATH, LANG, a temp HOME,
                             and no other variable of yours, unless you name it
  --ignore <kind[:tool]>     leave findings of this kind out of the report and the exit code
  --fail-on <tier>           any, safety, robustness, or none. The default is any
  --max-calls <n>            calls per tool. The default is 300
  --json, --name, --timeout  as for run

exit codes:
  0  no scenario that decides the run failed, errored, or regressed.
     For a scan: no finding of a tier that --fail-on counts
  1  a scenario that decides the run failed, errored, or regressed.
     For a scan: a finding of a tier that --fail-on counts
  2  the command line, the adapter, or a file was wrong.
     For a scan: also when no tool answered a plain call, so nothing was tested
`;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SCAN_CALLS = 300;
const MAX_TIMEOUT_MS = 2_147_483_647;

type RunMode =
  | { kind: "adapter"; spec: string }
  | { kind: "exec"; command: string }
  | { kind: "http"; url: string }
  | { kind: "mcp"; command: string };

type RunFlags = {
  mode: RunMode;
  scenarios: readonly string[];
  categories: readonly string[];
  tiers: readonly Tier[];
  failOn: Tier | "any";
  structured: boolean;
  toolNames: ReadonlyMap<string, string>;
  argumentNames: ReadonlyMap<string, string>;
  json: boolean;
  verbose: boolean;
  junit: string | undefined;
  sarif: string | undefined;
  sarifLocation: string | undefined;
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
  if (command === "list" || command === "show") {
    if (argv.includes("--help") || argv.includes("-h")) {
      stdout.write(HELP);
      return 0;
    }
    return command === "list"
      ? listCommand(argv.slice(1), stdout, stderr)
      : showCommand(argv.slice(1), stdout, stderr);
  }
  if (command === "scan") {
    if (argv.includes("--help") || argv.includes("-h")) {
      stdout.write(HELP);
      return 0;
    }
    return scanCommand(argv.slice(1), stdout, stderr);
  }
  if (command !== "run") {
    stderr.write(USAGE);
    return 2;
  }
  const flags = parseRunFlags(argv.slice(1));
  if ("help" in flags) {
    stdout.write(HELP);
    return 0;
  }
  if ("error" in flags) {
    stderr.write(`${flags.error}\n`);
    return 2;
  }
  const selected = selectScenarios(
    flags.scenarios,
    flags.categories,
    flags.tiers,
  );
  if ("error" in selected) {
    stderr.write(`${selected.error}\n`);
    return 2;
  }
  if (selected.scenarios.length === 0) {
    stderr.write(
      "no scenario matches --scenario, --category, and --tier together\n",
    );
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
  // Last, once the rest of the command line is known to be right. For --mcp
  // this starts the server and calls its tools.
  const adapter = await resolveRunAdapter(flags, stderr);
  if (!adapter) return 2;
  // --exec and --http enforce the limit themselves and kill what they
  // started. An in-process adapter gets the same limit from the runner.
  const options: RunOptions = {
    ...(flags.mode.kind === "adapter" ? { timeoutMs: flags.timeoutMs } : {}),
    ...(flags.structured ? { structured: true } : {}),
  };
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
  if (flags.sarif !== undefined) {
    const failure = writeReportFile(
      flags.sarif,
      formatSarif(
        adapter.name,
        version,
        results,
        scenarios,
        flags.sarifLocation ?? adapterFile(flags.mode) ?? ".",
      ),
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
  // --fail-on names the tier that decides the exit code. The report still
  // shows every scenario.
  const decides = (result: { tier?: Tier }): boolean =>
    flags.failOn === "any" || result.tier === flags.failOn;
  if (summary) {
    const regressed = new Set(summary.regressions);
    return results.some((result) => regressed.has(result.id) && decides(result))
      ? 1
      : 0;
  }
  const bad = results.some(
    (result) =>
      decides(result) &&
      (result.status === "fail" || result.status === "error"),
  );
  return bad ? 1 : 0;
}

// The file a SARIF viewer should open for a failure, when the target is one.
function adapterFile(mode: RunMode): string | undefined {
  return mode.kind === "adapter" && isAdapterPath(mode.spec)
    ? mode.spec
    : undefined;
}

const SCAN_KINDS: readonly string[] = [
  "outside-read",
  "outside-list",
  "outside-write",
  "url-file-read",
  "shell-injection",
  "phantom-tool",
  "crash",
  "hang",
  "bad-reply",
  "schema-not-enforced",
  "loopback-fetch",
  "soft-errors",
];

async function scanCommand(
  argv: readonly string[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  let mcp: string | undefined;
  let name: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let maxCalls = DEFAULT_SCAN_CALLS;
  let json = false;
  let destructive = false;
  let planOnly = false;
  let failOn: "any" | "safety" | "robustness" | "none" = "any";
  const only: string[] = [];
  const skip: string[] = [];
  const ignore: { kind: string; tool: string | undefined }[] = [];
  const env: Record<string, string> = {};
  const valued = new Set([
    "--mcp",
    "--name",
    "--timeout",
    "--max-calls",
    "--tool",
    "--skip",
    "--env",
    "--ignore",
    "--fail-on",
  ]);
  // Some of these messages quote the server: a tool name, what it printed
  // when it failed to start.
  const fail = (message: string): number => {
    stderr.write(`${printable(message)}\n`);
    return 2;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--destructive") {
      destructive = true;
      continue;
    }
    if (token === "--plan") {
      planOnly = true;
      continue;
    }
    if (!valued.has(token)) return fail(`unknown argument ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      return fail(`missing ${token} value`);
    }
    index += 1;
    if (token === "--mcp") mcp = value;
    else if (token === "--name") name = value;
    else if (token === "--tool" || token === "--skip") {
      // "," names nothing. Read as no filter, --tool would scan every tool.
      const names = splitList(value);
      if (names.length === 0) return fail(`missing ${token} value`);
      (token === "--tool" ? only : skip).push(...names);
    } else if (token === "--timeout" || token === "--max-calls") {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_TIMEOUT_MS) {
        return fail(`invalid ${token}`);
      }
      if (token === "--timeout") timeoutMs = Number(value);
      else maxCalls = Number(value);
    } else if (token === "--fail-on") {
      if (
        value !== "any" &&
        value !== "safety" &&
        value !== "robustness" &&
        value !== "none"
      ) {
        return fail(
          `invalid --fail-on ${value}; one of any, safety, robustness, none`,
        );
      }
      failOn = value;
    } else if (token === "--ignore") {
      // outside-read, or outside-read:read_file for one tool only.
      const colon = value.indexOf(":");
      const kind = colon < 0 ? value : value.slice(0, colon);
      const tool = colon < 0 ? undefined : value.slice(colon + 1);
      if (!SCAN_KINDS.includes(kind)) {
        return fail(`unknown finding ${kind}; one of ${SCAN_KINDS.join(", ")}`);
      }
      ignore.push({ kind, tool });
    } else {
      // NAME passes the variable on. NAME=value sets it.
      const equals = value.indexOf("=");
      const key = equals < 0 ? value : value.slice(0, equals);
      const given = equals < 0 ? process.env[key] : value.slice(equals + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return fail(`invalid --env ${value}`);
      }
      if (given === undefined) return fail(`--env ${key} is not set here`);
      env[key] = given;
    }
  }
  if (mcp === undefined) return fail("missing --mcp");
  let report: ScanReport;
  try {
    report = await scanMcp({
      command: mcp,
      name: name ?? `mcp:${mcp}`,
      timeoutMs,
      only,
      skip,
      ignored: ignore.flatMap((rule) =>
        rule.tool === undefined ? [] : [rule.tool],
      ),
      destructive,
      env,
      maxCallsPerTool: maxCalls,
      planOnly,
    });
  } catch (error) {
    // A misspelled tool name is found before anything is called.
    if (error instanceof ScanUsageError) return fail(error.message);
    return fail(`could not scan the MCP server: ${errorLine(error)}`);
  }
  const keep = (finding: ScanReport["findings"][number]): boolean =>
    !ignore.some(
      (rule) =>
        rule.kind === finding.kind &&
        (rule.tool === undefined || rule.tool === finding.tool),
    );
  const findings = report.findings.filter(keep);
  const kept: ScanReport = {
    ...report,
    findings,
    // The rows count what the report shows.
    tools: report.tools.map((row) => ({
      ...row,
      findings: findings.filter((finding) => finding.tool === row.name).length,
    })),
  };
  stdout.write(json ? formatScanJson(kept) : formatScan(kept));
  const ignored = report.findings.length - findings.length;
  if (ignored > 0) {
    stderr.write(
      `note: ${ignored} ${ignored === 1 ? "finding" : "findings"} left out by --ignore\n`,
    );
  }
  if (planOnly) return 0;
  // A scan in which no tool gave a result for a plain call tested nothing.
  // That is not a clean scan, and it does not exit as one.
  const exercised = kept.tools.some(
    (row) => row.status === "scanned" && row.plain === "answered",
  );
  if (!exercised && findings.length === 0 && failOn !== "none") {
    stderr.write(
      "no tool answered a plain call, so nothing was tested. A tool may need a variable from --env, or the server may want arguments on its command line\n",
    );
    return 2;
  }
  const totals = scanTotals(findings);
  const bad =
    failOn === "none"
      ? 0
      : failOn === "any"
        ? totals.safety + totals.robustness
        : totals[failOn];
  return bad > 0 ? 1 : 0;
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

function parseRunFlags(
  argv: readonly string[],
): RunFlags | { error: string } | { help: true } {
  let adapter: string | undefined;
  let exec: string | undefined;
  let http: string | undefined;
  let mcp: string | undefined;
  const tiers: Tier[] = [];
  let failOn: Tier | "any" = "any";
  let structured = false;
  const toolNames = new Map<string, string>();
  const argumentNames = new Map<string, string>();
  let sarif: string | undefined;
  let sarifLocation: string | undefined;
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
    // Only in flag position. `--name -h` names the adapter -h.
    if (token === "--help" || token === "-h") return { help: true };
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
    if (token === "--structured") {
      structured = true;
      continue;
    }
    if (
      token === "--adapter" ||
      token === "--exec" ||
      token === "--http" ||
      token === "--mcp" ||
      token === "--tool" ||
      token === "--arg" ||
      token === "--tier" ||
      token === "--fail-on" ||
      token === "--sarif" ||
      token === "--sarif-location" ||
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
        // A timer delay above 2^31-1 fires at once.
        if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_TIMEOUT_MS) {
          return { error: "invalid --timeout" };
        }
        timeoutMs = Number(value);
      } else if (token === "--name") {
        if (value.length === 0) return { error: "missing --name value" };
        name = value;
      } else if (token === "--adapter") adapter = value;
      else if (token === "--exec") exec = value;
      else if (token === "--http") http = value;
      else if (token === "--mcp") mcp = value;
      else if (token === "--sarif") sarif = value;
      else if (token === "--sarif-location") sarifLocation = value;
      else if (token === "--tool") {
        // read_file=read_text_file: what Gauntlet calls it, then what the
        // server calls it.
        const [from, to, ...rest] = value.split("=");
        if (
          (from !== "read_file" && from !== "write_file") ||
          to === undefined ||
          to.length === 0 ||
          rest.length > 0
        ) {
          return {
            error: `invalid --tool ${value}; use read_file=<name> or write_file=<name>`,
          };
        }
        toolNames.set(from, to);
      } else if (token === "--arg") {
        const [from, to, ...rest] = value.split("=");
        if (
          (from !== "path" && from !== "content") ||
          to === undefined ||
          to.length === 0 ||
          rest.length > 0
        ) {
          return {
            error: `invalid --arg ${value}; use path=<name> or content=<name>`,
          };
        }
        argumentNames.set(from, to);
      } else if (token === "--fail-on") {
        if (value !== "any" && !isTier(value)) {
          return {
            error: `invalid --fail-on ${value}; one of any, safety, robustness`,
          };
        }
        failOn = value;
      } else if (token === "--tier") {
        const names = splitList(value);
        if (names.length === 0) return { error: "missing --tier value" };
        for (const tier of names) {
          if (!isTier(tier)) {
            return { error: `unknown tier ${tier}; one of safety, robustness` };
          }
          tiers.push(tier);
        }
      } else if (token === "--baseline") baseline = value;
      else if (token === "--update-baseline") updateBaseline = value;
      else if (token === "--junit") junit = value;
      else {
        // An unset shell variable arrives as "". Running every scenario
        // would be the opposite of what was asked.
        const names = splitList(value);
        if (names.length === 0) return { error: `missing ${token} value` };
        if (token === "--category") categories.push(...names);
        else scenarioIds.push(...names);
      }
      index += 1;
      continue;
    }
    return { error: `unknown argument ${token}` };
  }
  const selected = [adapter, exec, http, mcp].filter(
    (item) => item !== undefined,
  ).length;
  if (selected === 0) {
    return { error: "missing --adapter, --exec, --http, or --mcp" };
  }
  if (selected > 1) {
    return {
      error: "--adapter, --exec, --http, and --mcp are mutually exclusive",
    };
  }
  if (toolNames.size > 0 && mcp === undefined) {
    return { error: "--tool needs --mcp" };
  }
  if (argumentNames.size > 0 && mcp === undefined) {
    return { error: "--arg needs --mcp" };
  }
  if (sarifLocation !== undefined && sarif === undefined) {
    return { error: "--sarif-location needs --sarif" };
  }
  // The file is the only thing that ties a finding to a place a viewer can
  // open. Without one, a code-scanning tool has nothing to show.
  if (
    sarif !== undefined &&
    sarifLocation === undefined &&
    !(adapter !== undefined && isAdapterPath(adapter))
  ) {
    return {
      error:
        "--sarif needs --sarif-location <path>: the file a viewer opens for a failure",
    };
  }
  if (failOn !== "any" && tiers.length > 0 && !tiers.includes(failOn)) {
    return {
      error: `--fail-on ${failOn} cannot decide a run of --tier ${tiers.join(",")}`,
    };
  }
  if (baseline !== undefined && updateBaseline !== undefined) {
    return {
      error: "--baseline and --update-baseline are mutually exclusive",
    };
  }
  // A baseline is the whole suite. Recording a filtered run would drop every
  // other scenario from the file, and they would come back as new.
  if (
    updateBaseline !== undefined &&
    (scenarioIds.length > 0 || categories.length > 0 || tiers.length > 0)
  ) {
    return {
      error:
        "--update-baseline records every scenario; remove --scenario, --category, and --tier",
    };
  }
  if (http !== undefined && !isHttpUrl(http)) {
    return { error: `invalid --http url ${http}` };
  }
  const shared = {
    scenarios: scenarioIds,
    categories,
    tiers,
    failOn,
    // An MCP server only ever receives parsed calls.
    structured: structured || mcp !== undefined,
    toolNames,
    argumentNames,
    json,
    verbose,
    junit,
    sarif,
    sarifLocation,
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
  if (mcp !== undefined) {
    return { mode: { kind: "mcp", command: mcp }, ...shared };
  }
  if (adapter === undefined) {
    return { error: "missing --adapter, --exec, --http, or --mcp" };
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
  if (flags.mode.kind === "mcp") {
    const server = mcpAdapter(
      flags.mode.command,
      flags.timeoutMs,
      flags.name ?? `mcp:${flags.mode.command}`,
      flags.toolNames,
      flags.argumentNames,
    );
    // One start before the run: list the tools, write a file, read it back.
    // A server that cannot do that gets one message, not the same error on
    // every row, and never a row of passes it did not earn.
    const check = await server.check();
    // Both lines quote the server: its tool names, or what it replied.
    if (check.problem !== undefined) {
      stderr.write(`${printable(check.problem)}\n`);
      return undefined;
    }
    if (check.note !== undefined) {
      stderr.write(`note: ${printable(check.note)}\n`);
    }
    return server;
  }
  const adapter = await resolveAdapter(flags.mode.spec, stderr);
  if (!adapter || flags.name === undefined) return adapter;
  return {
    name: flags.name,
    run: (input) => adapter.run(input),
    close: () => adapter.close?.() ?? Promise.resolve(),
  };
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

function isTier(value: string): value is Tier {
  return value === "safety" || value === "robustness";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Ids and categories add up. A tier narrows whatever they selected. The
// report keeps the order of the full list.
function selectScenarios(
  ids: readonly string[],
  categories: readonly string[],
  tiers: readonly Tier[],
): { scenarios: readonly Scenario[] } | { error: string } {
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
  const named = ids.length > 0 || categories.length > 0;
  return {
    scenarios: scenarios.filter(
      (scenario) =>
        (!named ||
          ids.includes(scenario.id) ||
          categories.includes(scenario.category)) &&
        (tiers.length === 0 || tiers.includes(scenario.tier)),
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

// A write to a pipe can still be queued when the process exits, and exit
// drops what is queued. The empty write calls back once the stream is flushed.
function flushed(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

if (isDirectRun()) {
  // An interrupt ends the run, and what the run started ends with it.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    // A closed terminal. What the run started is in its own process group
    // and would not hear of it otherwise.
    ["SIGHUP", 129],
  ] as const) {
    process.once(signal, () => {
      runCleanups();
      process.exit(code);
    });
  }
  const code = await runCli(
    process.argv.slice(2),
    process.stdout,
    process.stderr,
  );
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  // exit, not exitCode: an adapter that timed out may hold the loop open.
  process.exit(code);
}
