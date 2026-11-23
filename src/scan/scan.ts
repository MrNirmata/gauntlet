import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  McpFailure,
  type McpSession,
  type McpTool,
  openMcpSession,
  readMcpResult,
} from "../adapters/mcp.ts";
import { track } from "../cleanup.ts";
import {
  type BaseValues,
  isRecord,
  nature,
  readSchema,
  type SchemaReader,
  type StringPoint,
  withString,
  withValue,
  words,
} from "./schema.ts";

export type FindingTier = "safety" | "robustness" | "note";

export type FindingKind =
  | "outside-read"
  | "outside-list"
  | "outside-write"
  | "url-file-read"
  | "shell-injection"
  | "phantom-tool"
  | "crash"
  | "hang"
  | "bad-reply"
  | "schema-not-enforced"
  | "loopback-fetch"
  | "soft-errors";

export type Finding = {
  readonly kind: FindingKind;
  readonly tier: FindingTier;
  readonly cwe: readonly string[];
  readonly tool: string;
  // The argument the payload went in, when there was one.
  readonly argument?: string;
  // What happened, in one line.
  readonly detail: string;
  // The params of the tools/call request that did it, as JSON.
  readonly call: string;
  // For schema-not-enforced: each thing the schema rules out that got a
  // result anyway.
  readonly accepted?: readonly string[];
  // Other payloads on the same argument that did the same thing.
  more: number;
};

// What a call with nothing odd in it got.
export type PlainCall =
  | "answered"
  | "refused"
  | "crashed"
  | "hung"
  | "too large"
  | "not sent";

export type ToolRow = {
  readonly name: string;
  // planned: what --plan says would be called.
  readonly status: "scanned" | "skipped" | "planned";
  // Why it was skipped, or why the scan of it stopped early.
  readonly reason?: string;
  readonly calls: number;
  readonly plain: PlainCall;
  // Whether a plain call was seen to use one of its arguments in the scan's
  // own directory. Paths that leave a directory are sent only to such an
  // argument.
  readonly anchored: boolean;
  // String arguments that got payloads, how many of those also got paths
  // that leave a directory, and how many more strings there were.
  readonly strings: number;
  readonly paths: number;
  readonly unreached: number;
  readonly findings: number;
};

export type ScanReport = {
  readonly name: string;
  readonly server: string;
  readonly tools: readonly ToolRow[];
  readonly findings: readonly Finding[];
  // Why the scan ended before every tool was called, when it did.
  readonly stopped?: string;
  // The scan's temp directory, when a call left something in it that could
  // not be removed.
  readonly leftover?: string;
};

export type ScanOptions = {
  readonly command: string;
  readonly name: string;
  readonly timeoutMs: number;
  // Scan only these tools. Empty means all.
  readonly only: readonly string[];
  readonly skip: readonly string[];
  // Tools named with --ignore. Like the two above, a name the server does
  // not have is an error before any call.
  readonly ignored: readonly string[];
  // Also call tools that nothing marks or names as only reading.
  readonly write: boolean;
  // Also call tools that are marked, or named, as removing or sending.
  readonly destructive: boolean;
  // Variables the server is started with, on top of PATH and a temp HOME.
  readonly env: Readonly<Record<string, string>>;
  readonly maxCallsPerTool: number;
  // List what would be called and why, and call nothing.
  readonly planOnly: boolean;
};

// Something wrong with what was asked for, found before any tool is called.
export class ScanUsageError extends Error {}

const WHAT: Readonly<
  Record<FindingKind, { tier: FindingTier; cwe: readonly string[] }>
> = {
  "outside-read": { tier: "safety", cwe: ["CWE-22"] },
  "outside-list": { tier: "safety", cwe: ["CWE-22"] },
  "outside-write": { tier: "safety", cwe: ["CWE-22"] },
  "url-file-read": { tier: "safety", cwe: ["CWE-73"] },
  "shell-injection": { tier: "safety", cwe: ["CWE-78"] },
  "phantom-tool": { tier: "safety", cwe: ["CWE-470"] },
  crash: { tier: "robustness", cwe: ["CWE-248"] },
  hang: { tier: "robustness", cwe: ["CWE-400"] },
  "bad-reply": { tier: "robustness", cwe: [] },
  "schema-not-enforced": { tier: "robustness", cwe: ["CWE-20"] },
  "loopback-fetch": { tier: "note", cwe: ["CWE-918"] },
  "soft-errors": { tier: "note", cwe: [] },
};

const NOT_TOOLS = ["constructor", "toString", "__proto__", "hasOwnProperty"];
const RAW = "__GAUNTLET_RAW_VALUE__";
const LONG_TEXT_CHARS = 200_000;
const NESTING_DEPTH = 10_000;
const MAX_RESTARTS = 3;
const SETTLE_MS = 150;

// Why a tool is not called unless it was asked for. The scan makes up its
// arguments, so by default it calls only what is marked or named as reading.
// WRITES are the reasons --write lifts, and HELD the ones --destructive does.
export const WRITES = {
  unknown: "nothing says it only reads",
  marked: "the server marks it as not destructive, and not as read-only",
} as const;
export const HELD = {
  marked: "the server marks it destructive",
  unmarked:
    "the server says it is not read-only, and the default for that is destructive",
  named: "its name says it removes, sends, or spends",
  confirm: "it requires a confirmation",
} as const;

// A tool that runs what it is given. A command in its argument running is
// the tool working, not an injection.
const SHELL_NAME =
  /(^|[^a-z])(shell|bash|sh|zsh|powershell|terminal|repl)($|[^a-z])/i;
const RUN_NAME =
  /(^|[^a-z])(run|exec|execute|eval|evaluate|start|spawn)_(command|commands|cmd|script|code|shell|process|program)($|[^a-z])/i;
const RUN_ALONE = /^(exec|execute|eval|evaluate|cmd|command)$/i;
// "Run a shell command", "Executes the given script". Not "Runs the git log
// command for one file": that tool runs one command of its own.
const RUN_DESCRIPTION =
  /\b(run|runs|execute|executes|evaluate|evaluates)\s+(a|an|any|arbitrary|the given|given|shell|bash|python|javascript)\b[^.]{0,30}\b(command|commands|script|code)\b/i;
// A result that reads as a refusal. Some servers turn a bad call down in
// plain text, with no isError.
const REFUSAL =
  /^\W*(error|invalid|failed|failure|exception|bad request|validation|missing|unknown|cannot|could not|unable)\b|\b(is required|are required|must be|expected|invalid (type|argument|arguments|input|params?|parameters?)|validation (error|failed))\b/i;

type Probe = {
  // What the payload is, for the report.
  readonly what: string;
  readonly value: unknown;
  // JSON text to put in place of the value, for what a value cannot hold.
  readonly raw?: string;
  // A file:// address, so a leaked file is filed as a URL read.
  readonly viaUrl?: boolean;
  // What a report prints in place of a value too long to read.
  readonly shown?: string;
  // The marker file this payload tries to create.
  readonly marker?: string;
  // The payload names a place outside the server's directory.
  readonly outside?: boolean;
  // The name of a file it tries to create there.
  readonly creates?: string;
};

// The call a finding is put down to.
type Owner = {
  readonly tool: string;
  readonly argument: string | undefined;
  readonly what: string;
  readonly call: string;
};

type Outcome = {
  status:
    | "result"
    | "error"
    | "crash"
    | "hang"
    | "oversize"
    | "bad-reply"
    | "down";
  text: string;
};

// What the scan plants and then looks for. Each token is random and none is
// ever sent to the server, so one is in a reply only if the server put it
// there.
type Canaries = {
  // Removed when the scan ends. Everything else is inside it.
  readonly top: string;
  // Where the planted files are, three levels down, so that a tool told to
  // go up a level or two is still inside what the scan made.
  readonly root: string;
  // The server's directory.
  readonly workspace: string;
  readonly home: string;
  readonly values: BaseValues;
  readonly absolute: BaseValues;
  readonly linkOut: string;
  readonly linkDir: string;
  // A file beside the workspace, and one in a directory beside it.
  readonly secretFile: string;
  readonly deepFile: string;
  readonly outsideDir: string;
  readonly secretText: string;
  // Which of the strings a call was given the call was seen to use in the
  // workspace: the reply holds what only the file it names holds, or what
  // it names changed or appeared.
  used(sent: readonly string[], reply: string): Set<string>;
  // Files beside the workspace whose names only a listing shows.
  readonly unlisted: readonly string[];
  marker(id: string): string;
  // Remembers what the server itself put in its directory at start.
  adopt(): void;
  // Puts back what a call changed outside, and says what that was.
  restore(): {
    damaged: string | undefined;
    created: string[];
    markers: string[];
  };
  // Empties the workspace of what earlier calls left in it.
  clear(): void;
};

// Calls the tools an MCP server lists, with arguments made from each tool's
// own schema, and reports what the server did that it should not have.
//
// A finding is never a guess. It is a planted token in a reply, a planted
// file that changed, a marker file a payload created, or a server that
// stopped answering. A call the server merely turned down proves nothing,
// and a tool that turned down even a plain call is reported as such.
export async function scanMcp(options: ScanOptions): Promise<ScanReport> {
  const canaries = plant();
  const untrack = track(() => {
    removeTree(canaries.top, canaries.top);
  });
  let loopback: Loopback | undefined;
  let session: McpSession | undefined;
  // Why the server could not be started again after it went down.
  let down: string | undefined;
  const findings: Finding[] = [];
  const rows: ToolRow[] = [];
  // The call that carried each name a payload tries to create.
  const owners = new Map<string, Owner>();
  // The last call that named a place outside the server's directory.
  let lastOutside: Owner | undefined;
  // Tools that gave a reply too large to read.
  const tooLarge = new Set<string>();
  let softErrors = false;
  let markers = 0;
  let values = canaries.values;
  let absolute = canaries.absolute;

  // The server gets a search path and a home of its own, and no other
  // variable unless it was asked for. A token in the user's environment is
  // not in the server's.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: canaries.home,
    TMPDIR: canaries.home,
    LANG: process.env.LANG ?? "C.UTF-8",
    // git does not look above the scan's directory for a repository.
    GIT_CEILING_DIRECTORIES: canaries.top,
    ...options.env,
  };
  const open = (): Promise<McpSession> =>
    openMcpSession(options.command, canaries.workspace, options.timeoutMs, {
      env,
    });

  const add = (
    kind: FindingKind,
    tool: string,
    argument: string | undefined,
    detail: string,
    call: string,
  ): void => {
    const same = findings.find(
      (item) =>
        item.kind === kind && item.tool === tool && item.argument === argument,
    );
    if (same) {
      same.more += 1;
      return;
    }
    findings.push({
      kind,
      ...WHAT[kind],
      tool,
      ...(argument === undefined ? {} : { argument }),
      detail,
      call,
      more: 0,
    });
  };

  const send = async (
    tool: string,
    argumentsJson: string,
  ): Promise<Outcome> => {
    if (down !== undefined || session === undefined) {
      return { status: "down", text: down ?? "the server is not running" };
    }
    const params = `{"name":${JSON.stringify(tool)},"arguments":${argumentsJson}}`;
    try {
      const reply = await session.request("tools/call", params);
      if (reply.error === undefined && (reply.result ?? null) === null) {
        return { status: "bad-reply", text: "no result and no error" };
      }
      const { text, failed } = readMcpResult(reply, true);
      return { status: failed ? "error" : "result", text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const kind = error instanceof McpFailure ? error.kind : "exit";
      await session.stop();
      try {
        session = await open();
      } catch (again) {
        down = `the server did not start again: ${again instanceof Error ? again.message : String(again)}`;
      }
      return {
        status:
          kind === "timeout"
            ? "hang"
            : kind === "oversize"
              ? "oversize"
              : "crash",
        text,
      };
    }
  };

  // What the planted files show. A file a payload names is put down to the
  // call that carried the name, however late it appeared. A change that
  // carries no name is put down to the call that just ran if that call
  // named a place outside, and otherwise to the last one that did.
  const collect = (current: Owner, named: boolean): void => {
    const left = canaries.restore();
    const blame = (what: string): void => {
      // The call that just ran named a place outside, or nothing has yet.
      if (named || lastOutside === undefined) {
        add(
          "outside-write",
          current.tool,
          current.argument,
          `${what}, with ${current.what}.`,
          current.call,
        );
        return;
      }
      // An earlier call to the same tool named one, and this call did not:
      // the change is that call's, noticed late.
      if (lastOutside.tool === current.tool) {
        add(
          "outside-write",
          lastOutside.tool,
          lastOutside.argument,
          `${what}. It was noticed after a later call to the same tool, and is put down to the last call that named a place outside: ${lastOutside.what}.`,
          lastOutside.call,
        );
        return;
      }
      // Another tool's call. This one may have written through a symlink
      // in its directory, or the other tool may have still been working.
      add(
        "outside-write",
        current.tool,
        current.argument,
        `${what}, noticed after ${current.what}. This call named no place outside: it wrote through a symlink in the server's directory, or an earlier call to ${lastOutside.tool} was still working.`,
        current.call,
      );
    };
    for (const name of left.created) {
      const owner =
        owners.get(name) ??
        [...owners].find(([key]) => name.startsWith(key))?.[1];
      if (owner === undefined) {
        blame(`A file appeared outside the server's directory (${name})`);
        continue;
      }
      add(
        "outside-write",
        owner.tool,
        owner.argument,
        `A file appeared outside the server's directory (${name}), with ${owner.what}.`,
        owner.call,
      );
    }
    if (left.damaged !== undefined) blame(left.damaged);
    for (const name of left.markers) {
      const owner = owners.get(name);
      if (!owner) continue;
      add(
        "shell-injection",
        owner.tool,
        owner.argument,
        `A command inside the argument ran: ${owner.what} created the marker file it names.`,
        owner.call,
      );
    }
  };

  // Everything one call can show, checked after every call.
  const judge = (
    tool: string,
    argument: string | undefined,
    probe: Probe | undefined,
    printed: string,
    outcome: Outcome,
  ): string => {
    const call = `{"name":${JSON.stringify(tool)},"arguments":${shorten(printed)}}`;
    const what = probe === undefined ? "a plain call" : probe.what;
    const owner: Owner = { tool, argument, what, call };
    if (probe?.marker !== undefined) {
      owners.set(path.basename(probe.marker), owner);
    }
    if (probe?.creates !== undefined) owners.set(probe.creates, owner);
    if (probe?.outside === true) lastOutside = owner;
    if (outcome.status === "crash") {
      add(
        "crash",
        tool,
        argument,
        `The server exited on ${what}: ${outcome.text}`,
        call,
      );
    } else if (outcome.status === "hang") {
      add(
        "hang",
        tool,
        argument,
        `The server did not answer ${what}: ${outcome.text}`,
        call,
      );
    } else if (outcome.status === "oversize") {
      // A large reply is not a fault: a screenshot is one. The scan cannot
      // read it, and the row says so.
      tooLarge.add(tool);
    } else if (outcome.status === "bad-reply") {
      add(
        "bad-reply",
        tool,
        argument,
        `The reply to ${what} had ${outcome.text}.`,
        call,
      );
    }
    if (holds(outcome.text, canaries.secretText)) {
      if (probe?.viaUrl === true) {
        add(
          "url-file-read",
          tool,
          argument,
          "The reply holds the contents of a local file, read through a file:// address.",
          call,
        );
      } else if (probe === undefined) {
        add(
          "outside-read",
          tool,
          argument,
          "The reply to a plain call holds the contents of a file outside the server's directory. The tool followed a symlink in its directory that points there.",
          call,
        );
      } else {
        add(
          "outside-read",
          tool,
          argument,
          `The reply holds the contents of a file outside the server's directory, reached with ${what}.`,
          call,
        );
      }
    }
    if (canaries.unlisted.some((name) => outcome.text.includes(name))) {
      add(
        "outside-list",
        tool,
        argument,
        `The reply names a file outside the server's directory, which only a listing of that directory shows. It was reached with ${what}.`,
        call,
      );
    }
    collect(owner, probe?.outside === true);
    if (
      loopback?.take() === true &&
      probe !== undefined &&
      probe.viaUrl !== true
    ) {
      add(
        "loopback-fetch",
        tool,
        argument,
        "The server fetched an address on this machine that the argument gave it.",
        call,
      );
    }
    return call;
  };

  const run = async (): Promise<ScanReport> => {
    loopback = await listen();
    // A plain call to a tool that takes an address fetches this one.
    const okUrl = loopback.url("ok");
    values = { ...canaries.values, url: okUrl };
    absolute = { ...canaries.absolute, url: okUrl };
    session = await open();
    canaries.adopt();
    const listed = session.toolList.map((tool) => tool.name);
    const unknown = [...options.only, ...options.skip].filter(
      (name) => !listed.includes(name),
    );
    // Before the first call. A misspelled --skip must not let the scan go on
    // to call the tool it was meant to leave alone.
    if (unknown.length > 0) {
      throw new ScanUsageError(
        `the MCP server has no tool named ${unknown.join(", ")}. Its tools: ${listed.join(", ")}`,
      );
    }
    const [stray] = options.ignored.filter((name) => !listed.includes(name));
    if (stray !== undefined) {
      throw new ScanUsageError(
        `--ignore names ${stray}, which is not a tool of this server. Its tools: ${listed.join(", ")}`,
      );
    }
    const server = session.serverInfo;
    if (options.planOnly) {
      for (const tool of session.toolList) {
        let reason = skipReason(tool, options);
        let strings = 0;
        let unreached = 0;
        try {
          const reader = readSchema(tool.inputSchema);
          const { points, skipped } = reader.points(reader.plain(values));
          strings = points.length;
          unreached = skipped;
        } catch {
          reason ??= UNREADABLE;
        }
        rows.push({
          name: tool.name,
          status: reason === undefined ? "planned" : "skipped",
          ...(reason === undefined ? {} : { reason }),
          calls: 0,
          plain: "not sent",
          anchored: false,
          strings,
          paths: 0,
          unreached,
          findings: 0,
        });
      }
      return { name: options.name, server, tools: rows, findings };
    }

    // Names that are on every object, and one that is on none.
    const answered: string[] = [];
    const nowhere = `gauntlet-no-such-tool-${token(4)}`;
    // A server may really have a tool called toString. Only names it does
    // not list are tried.
    const absent = NOT_TOOLS.filter((name) => !listed.includes(name));
    for (const name of [nowhere, ...absent]) {
      const call = `{"name":${JSON.stringify(name)},"arguments":{}}`;
      const outcome = await send(name, "{}");
      if (outcome.status === "result") answered.push(name);
      else if (outcome.status === "crash") {
        add(
          "crash",
          name,
          undefined,
          `The server exited on a call to a tool it does not list: ${outcome.text}`,
          call,
        );
      } else if (outcome.status === "hang") {
        add(
          "hang",
          name,
          undefined,
          `The server did not answer a call to a tool it does not list: ${outcome.text}`,
          call,
        );
      }
      collect(
        {
          tool: name,
          argument: undefined,
          what: "a call to a tool it does not list",
          call,
        },
        false,
      );
      loopback.take();
    }
    if (answered.includes(nowhere)) {
      // A made-up name got a result, so this server reports a failure as a
      // result. A result then proves nothing, and nothing is built on one.
      softErrors = true;
      add(
        "soft-errors",
        nowhere,
        undefined,
        "The server gave a result, not an error, for a tool that does not exist. On this server a refusal cannot be told from a result, so tool names and schemas were not judged, and a plain call that looks answered may have been turned down.",
        `{"name":${JSON.stringify(nowhere)},"arguments":{}}`,
      );
    } else if (answered.length > 0) {
      const [first = ""] = answered;
      add(
        "phantom-tool",
        first,
        undefined,
        `The server answered a call to ${answered.map((name) => `"${name}"`).join(", ")}, which ${answered.length === 1 ? "is" : "are"} not in its list of tools.`,
        `{"name":${JSON.stringify(first)},"arguments":{}}`,
      );
    }

    for (const tool of session.toolList) {
      rows.push(await scanTool(tool));
    }
    // What a tool started and left running may still write.
    await settle(SETTLE_MS * 2);
    collect(
      {
        tool: "(after the scan)",
        argument: undefined,
        what: "no call in particular: it was noticed after every tool had answered",
        call: "{}",
      },
      false,
    );
    return {
      name: options.name,
      server,
      tools: rows,
      findings,
      ...(down === undefined ? {} : { stopped: down }),
    };
  };

  let report: ScanReport;
  let removed = true;
  try {
    report = await run();
  } finally {
    await session?.stop();
    await loopback?.close();
    untrack();
    // After the report is made. A file a call left that cannot be removed
    // does not cost the user the report.
    removed = removeTree(canaries.top, canaries.top);
  }
  return removed ? report : { ...report, leftover: canaries.top };

  async function scanTool(tool: McpTool): Promise<ToolRow> {
    const row = (
      status: ToolRow["status"],
      rest: Partial<ToolRow>,
    ): ToolRow => ({
      name: tool.name,
      status,
      calls: 0,
      plain: "not sent",
      anchored: false,
      strings: 0,
      paths: 0,
      unreached: 0,
      findings: 0,
      ...rest,
    });
    const skipped = skipReason(tool, options);
    if (skipped !== undefined) return row("skipped", { reason: skipped });
    if (down !== undefined) return row("skipped", { reason: down });
    let reader: SchemaReader;
    let cut = false;
    try {
      reader = readSchema(tool.inputSchema);
      reader.plain(values);
      cut = reader.truncated();
    } catch {
      return row("skipped", { reason: UNREADABLE });
    }

    const before = findings.length;
    const runsCommands = isCommandTool(tool);
    const readOnly = tool.annotations?.readOnlyHint === true;
    let calls = 0;
    let restarts = 0;
    let stopped: string | undefined;
    let lastCall = `{"name":${JSON.stringify(tool.name)},"arguments":{}}`;
    // The arguments of a call that the call was seen to use in the scan's
    // own directory: the reply holds what only the file it names holds, or
    // what it names changed or appeared. Every argument has a value no other
    // has. One that shares its value with another proves nothing, and is
    // left out.
    const seen = (
      args: Record<string, unknown>,
      outcome: Outcome,
    ): Set<string> => {
      const labels = new Set<string>();
      if (outcome.status !== "result") return labels;
      const { points } = reader.points(args);
      const given = points.map((point) => valueAt(args, point.pointer));
      const strings = given.filter(
        (item): item is string => typeof item === "string",
      );
      const used = canaries.used(strings, outcome.text);
      points.forEach((point, index) => {
        const value = given[index];
        if (
          typeof value === "string" &&
          used.has(value) &&
          strings.filter((item) => item === value).length === 1
        ) {
          labels.add(point.label);
        }
      });
      return labels;
    };

    // One call: send it, then look at everything it could have left.
    const call = async (
      argument: string | undefined,
      probe: Probe | undefined,
      args: Record<string, unknown>,
    ): Promise<{ outcome: Outcome; labels: Set<string> } | undefined> => {
      if (stopped !== undefined) return undefined;
      if (down !== undefined) {
        stopped = down;
        return undefined;
      }
      if (calls >= options.maxCallsPerTool) {
        stopped = `stopped after ${options.maxCallsPerTool} calls`;
        return undefined;
      }
      calls += 1;
      const text = JSON.stringify(args);
      const placeholder = JSON.stringify(RAW);
      const argumentsJson =
        probe?.raw === undefined
          ? text
          : text.replace(placeholder, () => probe.raw ?? "null");
      const outcome = await send(tool.name, argumentsJson);
      // The report prints a short stand-in for a value nobody would read.
      const printed =
        probe?.shown === undefined
          ? argumentsJson
          : text.replace(
              probe.raw === undefined
                ? JSON.stringify(probe.value)
                : placeholder,
              () => probe.shown ?? "",
            );
      // Before anything is put back: what a plain call changed is how the
      // scan knows which argument it used here.
      const labels =
        probe === undefined ? seen(args, outcome) : new Set<string>();
      lastCall = judge(tool.name, argument, probe, printed, outcome);
      if (
        outcome.status === "crash" ||
        outcome.status === "hang" ||
        outcome.status === "oversize"
      ) {
        restarts += 1;
        if (restarts >= MAX_RESTARTS) {
          stopped = `stopped after the server went down ${MAX_RESTARTS} times`;
        }
      }
      return { outcome, labels };
    };

    // A plain call first. A tool may want its path to be a file, a
    // directory, or a name that is not there yet, relative or in full, and
    // the schema rarely says which. Each form is tried until an argument is
    // seen to be used in the scan's own directory. Only such an argument is
    // sent a path that leaves a directory. A tool that keeps its data
    // somewhere else would resolve that path against that place, and the
    // scan could not see what it did there.
    const one = { others: [] as string[] };
    const bases: readonly BaseValues[] = [
      values,
      { ...values, ...one, path: values.dir },
      { ...values, ...one, path: values.fresh },
      { ...values, fresh: values.path },
      absolute,
      { ...absolute, ...one, path: absolute.dir },
      { ...absolute, ...one, path: absolute.fresh },
    ];
    let base = values;
    let plain = reader.plain(base);
    let first: Outcome | undefined;
    let anchors = new Set<string>();
    const tried = new Set<string>();
    for (const candidate of bases) {
      const args = reader.plain(candidate);
      const key = JSON.stringify(args);
      if (tried.has(key)) continue;
      tried.add(key);
      // Each tool, and each try, starts from the same directory.
      canaries.clear();
      const sent = await call(undefined, undefined, args);
      if (sent === undefined) break;
      const { outcome, labels } = sent;
      if (
        first === undefined ||
        labels.size > 0 ||
        (first.status !== "result" && outcome.status === "result")
      ) {
        first = outcome;
        base = candidate;
        plain = args;
        anchors = labels;
      }
      if (labels.size > 0) break;
      // A server that went down is not asked the same thing six more ways.
      if (outcome.status !== "error" && outcome.status !== "result") break;
    }
    const status = first?.status;
    const plainCall: PlainCall =
      status === "result"
        ? "answered"
        : status === "crash"
          ? "crashed"
          : status === "oversize"
            ? "too large"
            : status === "hang"
              ? "hung"
              : status === undefined
                ? "not sent"
                : "refused";

    type Target = {
      args: Record<string, unknown>;
      point: StringPoint;
      anchored: boolean;
    };
    const targets: Target[] = [];
    const required = reader.points(plain);
    const unreached = required.skipped;
    for (const point of required.points) {
      targets.push({ args: plain, point, anchored: anchors.has(point.label) });
    }
    // An optional argument is added to the plain call and tried the same
    // way, so it is judged on a call that had it.
    for (const { name } of reader.optional(base)) {
      let chosen:
        | { args: Record<string, unknown>; labels: Set<string> }
        | undefined;
      const sent = new Set<string>();
      for (const candidate of [base, ...bases]) {
        const extra = reader
          .optional(candidate)
          .find((item) => item.name === name);
        if (extra === undefined) continue;
        const args = withValue(plain, name, extra.value);
        // An optional switch or option is not added: it has no string to
        // put a payload in, and adding it only makes the call do more.
        if (
          !reader.points(args).points.some((point) => point.pointer[0] === name)
        ) {
          break;
        }
        const key = JSON.stringify(args);
        if (sent.has(key)) continue;
        sent.add(key);
        canaries.clear();
        const made = await call(undefined, undefined, args);
        const outcome = made?.outcome;
        const labels = made?.labels ?? new Set<string>();
        const mine = reader
          .points(args)
          .points.filter((point) => point.pointer[0] === name);
        const hit = mine.some((point) => labels.has(point.label));
        if (chosen === undefined || hit) chosen = { args, labels };
        if (hit || outcome === undefined) break;
        if (outcome.status !== "error" && outcome.status !== "result") break;
      }
      if (chosen === undefined) continue;
      for (const point of reader.points(chosen.args).points) {
        if (point.pointer[0] !== name) continue;
        targets.push({
          args: chosen.args,
          point,
          anchored: chosen.labels.has(point.label),
        });
      }
    }

    for (const { args, point, anchored } of targets) {
      const current = valueAt(args, point.pointer);
      const probes = probesFor({
        point,
        current,
        canaries,
        loopback,
        withPaths: anchored,
        // An argument that is a command is meant to be run.
        withShell: !runsCommands && point.kind !== "command",
        inFull: typeof current === "string" && path.isAbsolute(current),
        nextMarker: () => {
          markers += 1;
          return canaries.marker(`${markers}-${token(3)}`);
        },
      });
      for (const probe of probes) {
        const value = probe.raw === undefined ? probe.value : RAW;
        await call(point.label, probe, withString(args, point.pointer, value));
      }
    }

    // Calls the schema forbids. One that gets a result was not checked
    // against the schema the server published. On a server that reports a
    // failure as a result, a result says nothing, so these are not sent.
    if (!softErrors && status === "result") {
      const accepted: string[] = [];
      let example = "";
      // A missing argument names nothing, and is what a tool is most likely
      // to read as "all of them" or as its own default file. One is left out
      // only of a tool the server marks read-only.
      const canDrop = (): boolean => readOnly;
      for (const violation of reader.violations(plain, canDrop)) {
        const sent = await call(
          undefined,
          { what: violation.label, value: null },
          violation.arguments,
        );
        // A result that says "Error: a must be a number" is the server
        // turning the call down in its own way.
        if (
          sent?.outcome.status === "result" &&
          !REFUSAL.test(sent.outcome.text)
        ) {
          accepted.push(violation.label);
          if (example.length === 0)
            example = JSON.stringify(violation.arguments);
        }
      }
      if (accepted.length > 0) {
        findings.push({
          kind: "schema-not-enforced",
          ...WHAT["schema-not-enforced"],
          tool: tool.name,
          detail: `The server gave a result for arguments its own schema rules out: ${accepted.join("; ")}.`,
          call: `{"name":${JSON.stringify(tool.name)},"arguments":${shorten(example)}}`,
          accepted,
          more: 0,
        });
      }
    }
    // What this tool started may finish a moment after it answered.
    await settle(SETTLE_MS);
    collect(
      {
        tool: tool.name,
        argument: undefined,
        what: "no call in particular: it was noticed after this tool's calls were answered, and the call below is the last one sent",
        call: lastCall,
      },
      false,
    );

    const named = (items: readonly Target[]): string => {
      const labels = [...new Set(items.map((item) => item.point.label))];
      const shown = labels.slice(0, 4).join(", ");
      return labels.length > 4
        ? `${shown}, and ${labels.length - 4} more`
        : shown;
    };
    const anchored = targets.some((item) => item.anchored);
    const reasons: string[] = [];
    if (stopped !== undefined) reasons.push(stopped);
    if (cut) {
      reasons.push("its schema asks for more values than a scan fills in");
    }
    if (tooLarge.has(tool.name)) {
      reasons.push(
        "a reply was too large to read, and the server was started again",
      );
    }
    if (!reader.described) {
      reasons.push("it publishes no arguments, so only a plain call was made");
    } else if (plainCall === "answered") {
      // Said for an argument that looks like a path. For any other string
      // the paths column has the count.
      const left = targets.filter(
        (item) => !item.anchored && item.point.kind === "path",
      );
      if (left.length > 0) {
        reasons.push(
          `no path that leaves a directory was sent to ${named(left)}: not seen to name a file in the scan's directory`,
        );
      }
    }
    if (targets.length > 0 && runsCommands) {
      reasons.push(
        "no command was put in its arguments: the tool runs commands by design",
      );
    } else {
      const commands = targets.filter((item) => item.point.kind === "command");
      if (commands.length > 0) {
        reasons.push(
          `no command was added to ${named(commands)}: it takes a command`,
        );
      }
    }
    if (unreached > 0)
      reasons.push(`${unreached} more string arguments were not reached`);
    return row("scanned", {
      ...(reasons.length === 0 ? {} : { reason: reasons.join("; ") }),
      calls,
      plain: plainCall,
      anchored,
      strings: targets.length,
      paths: targets.filter((item) => item.anchored).length,
      unreached,
      findings: findings.slice(before).length,
    });
  }
}

const UNREADABLE = "its schema could not be read";

// Why a tool is left alone, or undefined when it is called.
function skipReason(tool: McpTool, options: ScanOptions): string | undefined {
  if (options.only.length > 0 && !options.only.includes(tool.name)) {
    return "not named with --tool";
  }
  if (options.skip.includes(tool.name)) return "named with --skip";
  // Named with --tool: the user asked for this one.
  if (options.destructive || options.only.includes(tool.name)) return undefined;
  const marks = tool.annotations ?? {};
  const writes = (reason: string): string | undefined =>
    options.write ? undefined : reason;
  if (marks.destructiveHint === true) return HELD.marked;
  if (marks.readOnlyHint === true) return undefined;
  // A tool that will not run without "confirm" or "force" is asking whether
  // the caller means it. A scan does not.
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (
    required.some(
      (name) =>
        typeof name === "string" &&
        /(^|[^a-z])(confirm|confirmed|confirmation|force|yes)($|[^a-z])/i.test(
          words(name),
        ),
    )
  ) {
    return HELD.confirm;
  }
  if (marks.readOnlyHint === false) {
    // The protocol's default for a tool that is not read-only is destructive.
    return marks.destructiveHint === false
      ? writes(WRITES.marked)
      : HELD.unmarked;
  }
  // What the server says outright counts for more than a name.
  if (marks.destructiveHint === false) return writes(WRITES.marked);
  const says = nature(tool.name);
  if (says === "removes") return HELD.named;
  return says === "reads" ? undefined : writes(WRITES.unknown);
}

function isCommandTool(tool: McpTool): boolean {
  const spaced = words(tool.name);
  return (
    SHELL_NAME.test(spaced) ||
    RUN_NAME.test(spaced) ||
    RUN_ALONE.test(spaced) ||
    RUN_DESCRIPTION.test(tool.description ?? "")
  );
}

// Removes a directory and what is in it. A call can leave a directory that
// cannot be written, as a package cache does. When removing fails, the
// directories are made writable and it is tried once more. top is the scan's
// own temp directory, and nothing outside it is touched.
function removeTree(target: string, top: string): boolean {
  for (const attempt of [0, 1]) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2 });
      return true;
    } catch {
      if (attempt === 0) unlock(target, top, 0);
    }
  }
  return false;
}

// Makes a directory under top writable, and the directories in it. A server
// may still have something running that swaps a directory for a symlink, so
// a name is not trusted between one step and the next: the directory is
// opened without following a link, checked to be the one that is really at
// that place under top, and changed through what was opened.
function unlock(target: string, top: string, depth: number): void {
  if (depth > 64) return;
  let handle: number | undefined;
  try {
    handle = openSync(
      target,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(handle);
    const real = realpathSync(target);
    const there = lstatSync(real);
    if (
      !opened.isDirectory() ||
      (real !== top && !real.startsWith(`${top}${path.sep}`)) ||
      there.ino !== opened.ino ||
      there.dev !== opened.dev
    ) {
      return;
    }
    fchmodSync(handle, 0o700);
  } catch {
    // What cannot be opened up is left, and the report says so.
    return;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  let names: string[] = [];
  try {
    names = readdirSync(target);
  } catch {
    return;
  }
  for (const name of names) unlock(path.join(target, name), top, depth + 1);
}

function probesFor(given: {
  point: StringPoint;
  current: unknown;
  canaries: Canaries;
  loopback: Loopback | undefined;
  withPaths: boolean;
  withShell: boolean;
  inFull: boolean;
  nextMarker: () => string;
}): Probe[] {
  const { canaries, point } = given;
  const secretName = path.basename(canaries.secretFile);
  const deepName = path.basename(canaries.deepFile);
  const stem =
    typeof given.current === "string" &&
    /^[A-Za-z0-9._/:-]+$/.test(given.current)
      ? given.current
      : canaries.values.text;
  const probes: Probe[] = [
    {
      what: "a NUL byte in the value",
      value: `${canaries.values.path}\u0000.md`,
    },
    {
      what: `a string of ${LONG_TEXT_CHARS} characters`,
      value: "A".repeat(LONG_TEXT_CHARS),
      shown: `"AAAA... ${LONG_TEXT_CHARS} characters"`,
    },
    {
      what: "control characters",
      value: `${canaries.values.text}\u0007\u001b[2J\u0085`,
    },
    {
      what: "a lone surrogate",
      value: null,
      raw: `"${canaries.values.text}\\ud800"`,
    },
    {
      what: `${NESTING_DEPTH} nested arrays where a string goes`,
      value: null,
      // Not empty at the centre. A server that turns the arrays into a
      // string gets this word, and not an empty string, for a name.
      raw: `${"[".repeat(NESTING_DEPTH)}${JSON.stringify(canaries.values.text)}${"]".repeat(NESTING_DEPTH)}`,
      shown: `"[[[[... ${NESTING_DEPTH} arrays deep"`,
    },
  ];
  if (given.withPaths) {
    // Every one of these names a place the scan made. None is empty, and
    // none goes further up than the scan's own directories reach.
    const created = `gauntlet-created-${token(3)}.txt`;
    const relative: [string, string, string?][] = [
      ["a path that starts with ../", `../${secretName}`],
      [
        "a path that goes down and back up",
        `${canaries.values.dir}/../../${secretName}`,
      ],
      ["a symlink that points outside", canaries.linkOut],
      [
        "a path through a symlinked directory",
        `${canaries.linkDir}/${deepName}`,
      ],
      // Never the bare parent: wherever a path lands, it names only what
      // the scan made.
      ["a directory one level up", `../${path.basename(canaries.outsideDir)}`],
      ["a symlinked directory", canaries.linkDir],
      ["a new file one level up", `../${created}`, created],
    ];
    for (const [what, value, creates] of relative) {
      // An argument that was seen to work only with a path in full is given
      // the same path in full, still with its .. or its symlink in it. It is
      // not given the short form: where it would resolve that was not seen.
      probes.push({
        what: given.inFull ? `${what}, written in full` : what,
        value: given.inFull ? `${canaries.workspace}/${value}` : value,
        outside: true,
        ...(creates === undefined ? {} : { creates }),
      });
    }
    const made = `gauntlet-created-${token(3)}.txt`;
    probes.push(
      { what: "an absolute path", value: canaries.secretFile, outside: true },
      {
        what: "the absolute path of the parent directory",
        value: canaries.root,
        outside: true,
      },
      {
        what: "a new file at an absolute path outside",
        value: path.join(canaries.root, made),
        outside: true,
        creates: made,
      },
    );
  }
  if (given.withShell) {
    const shells: [string, (marker: string) => string][] = [
      ["a ; and a command", (marker) => `${stem}; touch ${marker}`],
      ["a $( ) command", (marker) => `${stem}$(touch ${marker})`],
      ["a backtick command", (marker) => `${stem}\`touch ${marker}\``],
      ["a | and a command", (marker) => `${stem} | touch ${marker}`],
      ["a && and a command", (marker) => `${stem} && touch ${marker}`],
      ["a line break and a command", (marker) => `${stem}\ntouch ${marker}`],
      [
        "a ' that closes a quote, and a command",
        (marker) => `${stem}'; touch ${marker}; '`,
      ],
      [
        'a " that closes a quote, and a command',
        (marker) => `${stem}"; touch ${marker}; "`,
      ],
    ];
    for (const [what, build] of shells) {
      const marker = given.nextMarker();
      probes.push({ what, value: build(marker), marker });
    }
  }
  if (point.kind === "url" && given.loopback !== undefined) {
    probes.push(
      {
        what: "a file:// address",
        value: `file://${canaries.secretFile}`,
        viaUrl: true,
        outside: true,
      },
      {
        what: "an address on this machine",
        value: given.loopback.url(`gauntlet-${token(4)}`),
      },
    );
  }
  return probes;
}

// A temp directory whose path a shell reads as one plain word. The payloads
// that try to run a command name a file in it, unquoted, because a quote
// would change what the payload tests.
function plainTemp(): string {
  for (const candidate of [os.tmpdir(), "/tmp"]) {
    try {
      const real = realpathSync(candidate);
      if (/^[A-Za-z0-9/._-]+$/.test(real)) return real;
    } catch {
      // Not there. Try the next.
    }
  }
  throw new ScanUsageError(
    "the temp directory has a space or a shell character in its path. Set TMPDIR to a directory that has neither",
  );
}

function plant(): Canaries {
  const id = token(4);
  const top = mkdtempSync(path.join(plainTemp(), "gauntlet-scan-"));
  const root = path.join(top, "guard", "guard", "outer");
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const outsideDir = path.join(root, `gauntlet-${id}-outside-dir`);
  const secretFile = path.join(root, `gauntlet-${id}-outside.txt`);
  const deepFile = path.join(outsideDir, `gauntlet-${id}-deep.txt`);
  const secretText = `gauntlet-secret-${token(12)}`;
  const unlisted = [
    `gauntlet-unlisted-${token(8)}.txt`,
    `gauntlet-unlisted-${token(8)}.txt`,
  ];
  const [unlistedRoot = "", unlistedDeep = ""] = unlisted;
  const dir = `gauntlet-${id}-dir`;
  const fresh = `gauntlet-${id}-made.txt`;
  const linkOut = `gauntlet-${id}-link-out`;
  const linkDir = `gauntlet-${id}-link-dir`;
  const text = `gauntlet-${id}`;
  // Three notes, one for each of the first three path arguments of a call.
  // Each holds a mark that is never sent, so a reply with a mark in it read
  // that note, and the argument that named the note is the one that did it.
  // Each also holds the word a plain call searches for or replaces, so a
  // tool that looks inside files finds something.
  const makeNote = (
    name: string,
  ): { name: string; mark: string; body: string } => {
    const mark = `gauntlet-note-${token(12)}`;
    return {
      name: `gauntlet-${id}-${name}.txt`,
      mark,
      body: `${text} ${mark}\n`,
    };
  };
  const note = makeNote("note");
  const notes = [note, makeNote("note-b"), makeNote("note-c")];
  // In the directory, and never sent. It starts with the word a plain call
  // searches for, so a search by name finds it.
  const innerName = `${text}-inner-${token(8)}.txt`;
  // What the file in the directory holds, with the same word in front.
  const innerMark = `gauntlet-inner-${token(12)}`;
  const innerBody = `${text} ${innerMark}\n`;
  // The files outside hold the word too, so a tool that searches or replaces
  // finds something in them, if it gets that far.
  const secretBody = `${text} ${secretText}\n`;
  const fixtures = new Set([
    ...notes.map((item) => item.name),
    dir,
    linkOut,
    linkDir,
  ]);
  const adopted = new Set<string>();
  const stuck = new Set<string>();
  const here = (name: string): string => path.join(workspace, name);

  // The scan's own directories, from the top down. A call can replace any
  // of them with a symlink to somewhere else. Before the scan lists, writes,
  // or removes anything, each is a real directory again, so nothing the scan
  // does next is done through a link.
  const chain = [
    top,
    path.join(top, "guard"),
    path.join(top, "guard", "guard"),
    root,
    workspace,
    home,
    outsideDir,
    here(dir),
  ];
  const secure = (): void => {
    for (const directory of chain) {
      const stat = lstatSync(directory, { throwIfNoEntry: false });
      if (stat?.isDirectory() === true) continue;
      // Removing a symlink removes the link, not what it points at.
      if (stat !== undefined) rmSync(directory, { force: true });
      mkdirSync(directory);
    }
  };
  // A file of the scan's own, read only if it is a plain file of a size the
  // scan would write. Not a link, not a pipe, not a device.
  const read = (file: string): string | undefined => {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const write = (file: string, body: string): void => {
    if (read(file) === body) return;
    removeTree(file, top);
    // A new file, never one that is already there under another name.
    writeFileSync(file, body, { flag: "wx" });
  };
  // Everything the scan planted, put back if a call removed or changed it.
  // A call can remove any of it, the directories above included.
  const replant = (): void => {
    secure();
    write(secretFile, secretBody);
    write(deepFile, secretBody);
    write(path.join(root, unlistedRoot), "gauntlet\n");
    write(path.join(outsideDir, unlistedDeep), "gauntlet\n");
    for (const item of notes) write(here(item.name), item.body);
    for (const name of list(here(dir))) {
      if (name !== innerName) remove(path.join(here(dir), name));
    }
    write(path.join(here(dir), innerName), innerBody);
    link(secretFile, here(linkOut));
    link(outsideDir, here(linkDir));
  };
  const remove = (target: string): void => {
    // A call left something that cannot be removed. It is not reported
    // again on every later call.
    if (!removeTree(target, top)) stuck.add(target);
  };
  const list = (directory: string): string[] => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  };
  const exists = (file: string): boolean => {
    try {
      return lstatSync(file, { throwIfNoEntry: false }) !== undefined;
    } catch {
      return false;
    }
  };
  replant();

  const values: BaseValues = {
    path: note.name,
    dir,
    fresh,
    url: "",
    text,
    others: notes.slice(1).map((item) => item.name),
  };
  return {
    top,
    root,
    workspace,
    home,
    values,
    absolute: {
      ...values,
      path: here(note.name),
      dir: here(dir),
      fresh: here(fresh),
      others: notes.slice(1).map((item) => here(item.name)),
    },
    linkOut,
    linkDir,
    secretFile,
    deepFile,
    outsideDir,
    secretText,
    used(sent, reply) {
      // A directory of the scan's that is now a link was changed. It is not
      // listed through.
      const real = (directory: string): boolean =>
        lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() === true;
      if (!chain.slice(0, 5).every(real)) return new Set();
      const names = list(workspace);
      const added = names.filter(
        (name) => !fixtures.has(name) && !adopted.has(name),
      );
      // What is new here may hold what a call read: a copy of a note.
      const copies = added.map((name) => read(here(name)) ?? "");
      const found = new Set<string>();
      for (const value of sent) {
        if (value.length === 0 || value.length > 4096 || value.includes("\0")) {
          continue;
        }
        const full = path.resolve(workspace, value);
        const inside = path.relative(workspace, full);
        if (
          inside === "" ||
          inside.startsWith("..") ||
          path.isAbsolute(inside)
        ) {
          continue;
        }
        const named = notes.find((item) => item.name === inside);
        if (named !== undefined) {
          if (
            holds(reply, named.mark) ||
            read(here(named.name)) !== named.body ||
            copies.some((copy) => copy.includes(named.mark))
          ) {
            found.add(value);
          }
          continue;
        }
        if (inside === dir) {
          const within = real(here(dir)) ? list(here(dir)) : [];
          if (
            reply.includes(innerName) ||
            holds(reply, innerMark) ||
            within.length !== 1 ||
            within[0] !== innerName
          ) {
            found.add(value);
          }
          continue;
        }
        const [first = ""] = inside.split(path.sep);
        if (first === linkOut || first === linkDir) continue;
        // A name that was not there is there now, as it is or with an
        // extension the tool added. A file the server made for itself, a
        // log or a cache, has neither name.
        if (exists(full)) found.add(value);
        else if (
          !inside.includes(path.sep) &&
          added.some(
            (name) =>
              name.startsWith(inside) &&
              /^\.[A-Za-z0-9]{1,8}$/.test(name.slice(inside.length)),
          )
        ) {
          found.add(value);
        }
      }
      return found;
    },
    unlisted,
    marker: (name) => path.join(root, `gauntlet-marker-${name}`),
    adopt() {
      for (const name of list(workspace)) {
        if (!fixtures.has(name)) adopted.add(name);
      }
    },
    restore() {
      let damaged: string | undefined;
      // First, so that what follows lists and removes in the scan's own
      // directories and nowhere a link leads.
      const replaced = chain
        .slice(0, 4)
        .some(
          (directory) =>
            lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() !==
            true,
        );
      if (replaced) {
        damaged =
          "The directory above the server's was removed or replaced by a link";
      }
      try {
        secure();
      } catch {
        return { damaged, created: [], markers: [] };
      }
      const created: string[] = [];
      const markers: string[] = [];
      for (const file of [secretFile, deepFile]) {
        const now = read(file);
        if (now === secretBody) continue;
        damaged ??=
          now === undefined
            ? "A file outside the server's directory was deleted"
            : "A file outside the server's directory was overwritten";
      }
      const kept = new Set([
        "workspace",
        "home",
        path.basename(outsideDir),
        path.basename(secretFile),
        unlistedRoot,
      ]);
      for (const name of list(root)) {
        if (kept.has(name)) continue;
        const target = path.join(root, name);
        if (stuck.has(target)) continue;
        if (name.startsWith("gauntlet-marker-")) markers.push(name);
        else created.push(name);
        remove(target);
      }
      const deep = new Set([path.basename(deepFile), unlistedDeep]);
      for (const name of list(outsideDir)) {
        if (deep.has(name)) continue;
        const target = path.join(outsideDir, name);
        if (stuck.has(target)) continue;
        created.push(name);
        remove(target);
      }
      try {
        replant();
      } catch {
        // What could not be put back shows as a change on the next call.
      }
      return { damaged, created, markers };
    },
    clear() {
      try {
        secure();
      } catch {
        return;
      }
      for (const name of list(workspace)) {
        // What the server made for itself when it started stays.
        if (adopted.has(name)) continue;
        remove(here(name));
      }
      try {
        replant();
      } catch {
        // The next call's checks see what is missing.
      }
    },
  };
}

// A symlink at linkPath to target, put back if a call replaced or removed it.
function link(target: string, linkPath: string): void {
  const stat = lstatSync(linkPath, { throwIfNoEntry: false });
  // The scan's own link, still pointing where the scan pointed it.
  if (stat?.isSymbolicLink() === true && readlinkSync(linkPath) === target) {
    return;
  }
  if (stat) rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath);
}

type Loopback = {
  url(name: string): string;
  // Whether an address made for a probe was asked for since the last take.
  take(): boolean;
  close(): Promise<void>;
};

// A web server on this machine only. A URL argument is pointed at it, and a
// request arriving here is how the scan knows the server fetched it.
async function listen(): Promise<Loopback> {
  let hit = false;
  const server: Server = createServer((request, response) => {
    // /ok is what a plain call fetches. Only an address made for a probe
    // counts, and a payload appended to /ok does not look like one.
    if ((request.url ?? "").startsWith("/gauntlet-")) hit = true;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("gauntlet loopback\n");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: (name) => `http://127.0.0.1:${port}/${name}`,
    take() {
      const was = hit;
      hit = false;
      return was;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Whether a reply holds the secret, as it is or in base64. A tool that
// returns a file as base64 has returned the file.
function holds(text: string, secret: string): boolean {
  if (text.includes(secret)) return true;
  // The same bytes read differently in base64 at each of three offsets.
  // The ends depend on what is next to the secret, so they are left off.
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([
      Buffer.alloc(offset, 0x20),
      Buffer.from(secret),
    ])
      .toString("base64")
      .replace(/=+$/, "");
    const needle = encoded.slice(offset === 0 ? 0 : 4, -4);
    if (needle.length >= 16 && text.includes(needle)) return true;
  }
  return false;
}

function valueAt(
  args: unknown,
  pointer: readonly (string | number)[],
): unknown {
  let node: unknown = args;
  for (const key of pointer) {
    if (Array.isArray(node) && typeof key === "number") node = node[key];
    else if (
      typeof node === "object" &&
      node !== null &&
      typeof key === "string"
    ) {
      node = (node as Record<string, unknown>)[key];
    } else return undefined;
  }
  return node;
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// The call in a report is something a person can paste. A value hundreds of
// thousands of characters long is cut in the middle.
function shorten(json: string): string {
  const limit = 600;
  if (json.length <= limit) return json;
  return `${json.slice(0, 380)} ... ${json.slice(-120)}`;
}

function token(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
