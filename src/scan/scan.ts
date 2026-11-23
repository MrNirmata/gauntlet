import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  readSchema,
  type StringPoint,
  withString,
  withValue,
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
  | "not sent";

export type ToolRow = {
  readonly name: string;
  // planned: what --plan says would be called.
  readonly status: "scanned" | "skipped" | "planned";
  // Why it was skipped, or why the scan of it stopped early.
  readonly reason?: string;
  readonly calls: number;
  readonly plain: PlainCall;
  // Whether the plain call was seen to work in the scan's own directory.
  // Paths that leave a directory are sent only to a tool that did.
  readonly anchored: boolean;
  // String arguments that got payloads, and how many more there were.
  readonly strings: number;
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
};

export type ScanOptions = {
  readonly command: string;
  readonly name: string;
  readonly timeoutMs: number;
  // Scan only these tools. Empty means all.
  readonly only: readonly string[];
  readonly skip: readonly string[];
  // Also call tools that are marked, or named, as changing or sending.
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

// A tool whose name says it removes, sends, or spends. The scan makes up
// its arguments, so such a tool is not called unless it was asked for. The
// name is all there is to go on: most servers mark nothing.
const CHANGES =
  /(^|[^a-z])(delete|remove|rm|drop|destroy|purge|wipe|erase|truncate|kill|terminate|shutdown|reboot|send|post|publish|deploy|pay|transfer|purchase|buy|email|sms|tweet|merge|push|reset|format|uninstall|revoke|ban|cancel)($|[^a-z])/i;
// A tool that runs what it is given. A command in its argument running is
// the tool working, not an injection.
const RUNS_COMMANDS =
  /(^|[^a-z])(shell|bash|sh|zsh|exec|execute|command|cmd|terminal|eval|repl|script)($|[^a-z])/i;

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
  readonly secretText: string;
  // The text of the note in the workspace, and the name of a second file
  // there. A reply that holds either shows the tool works in the workspace.
  // Whether a reply shows the tool working in the scan's directory.
  seenIn(text: string): boolean;
  // Files beside the workspace whose names only a listing shows.
  readonly unlisted: readonly string[];
  marker(id: string): string;
  // Remembers what the server itself put in its directory at start.
  adopt(): void;
  // Whether the workspace is other than the scan left it.
  touched(): boolean;
  // Puts back what a call changed outside, and says what that was.
  restore(): { wroteOutside: string | undefined; markers: string[] };
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
    rmSync(canaries.top, { recursive: true, force: true, maxRetries: 3 });
  });
  let loopback: Loopback | undefined;
  let session: McpSession | undefined;
  // Why the server could not be started again after it went down.
  let down: string | undefined;
  const findings: Finding[] = [];
  const rows: ToolRow[] = [];
  const owners = new Map<
    string,
    { tool: string; argument: string | undefined; what: string; call: string }
  >();
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

  // What the planted files show, attributed to the payload that names each
  // marker and not to whichever call happened to be running.
  const collect = (
    tool: string,
    argument: string | undefined,
    what: string,
    call: string,
  ): void => {
    const left = canaries.restore();
    if (left.wroteOutside !== undefined) {
      add(
        "outside-write",
        tool,
        argument,
        `${left.wroteOutside}, with ${what}.`,
        call,
      );
    }
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
  ): void => {
    const call = `{"name":${JSON.stringify(tool)},"arguments":${shorten(printed)}}`;
    const what = probe === undefined ? "a plain call" : probe.what;
    if (probe?.marker !== undefined) {
      owners.set(path.basename(probe.marker), { tool, argument, what, call });
    }
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
      add(
        "bad-reply",
        tool,
        argument,
        `The reply to ${what} was too large to read, and the scan stopped the server: ${outcome.text}`,
        call,
      );
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
    collect(tool, argument, what, call);
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
  };

  try {
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
    const server = session.serverInfo;
    if (options.planOnly) {
      for (const tool of session.toolList) {
        const reason = skipReason(tool, options);
        const reader = readSchema(tool.inputSchema);
        const { points, skipped } = reader.points(reader.plain(values));
        rows.push({
          name: tool.name,
          status: reason === undefined ? "planned" : "skipped",
          ...(reason === undefined ? {} : { reason }),
          calls: 0,
          plain: "not sent",
          anchored: false,
          strings: points.length,
          unreached: skipped,
          findings: 0,
        });
      }
      return { name: options.name, server, tools: rows, findings };
    }

    // Names that are on every object, and one that is on none.
    const answered: string[] = [];
    const nowhere = `gauntlet-no-such-tool-${token(4)}`;
    for (const name of [nowhere, ...NOT_TOOLS]) {
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
      collect(name, undefined, "a call to a tool it does not list", call);
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
      "(after the scan)",
      undefined,
      "something a call left running",
      "{}",
    );
    return {
      name: options.name,
      server,
      tools: rows,
      findings,
      ...(down === undefined ? {} : { stopped: down }),
    };
  } finally {
    await session?.stop();
    await loopback?.close();
    untrack();
    rmSync(canaries.top, { recursive: true, force: true, maxRetries: 3 });
  }

  async function scanTool(tool: McpTool): Promise<ToolRow> {
    const reader = readSchema(tool.inputSchema);
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
      unreached: 0,
      findings: 0,
      ...rest,
    });
    const skipped = skipReason(tool, options);
    if (skipped !== undefined) return row("skipped", { reason: skipped });
    if (down !== undefined) return row("skipped", { reason: down });

    const before = findings.length;
    const runsCommands = isCommandTool(tool);
    let calls = 0;
    let restarts = 0;
    let stopped: string | undefined;
    // One call: send it, then look at everything it could have left.
    const call = async (
      argument: string | undefined,
      probe: Probe | undefined,
      args: Record<string, unknown>,
    ): Promise<{ outcome: Outcome; touched: boolean } | undefined> => {
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
      const touched = canaries.touched();
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
      judge(tool.name, argument, probe, printed, outcome);
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
      return { outcome, touched };
    };

    // A plain call first. A tool may want its path to be a file, a
    // directory, or a name that is not there yet, relative or in full, and
    // the schema rarely says which. Each form is tried until the tool is
    // seen to work in the scan's own directory: it returned the text of the
    // note there, named a file only a listing shows, or changed something.
    // Only then are paths that leave a directory sent to it. A tool that
    // keeps its data somewhere else would resolve those against that place,
    // and the scan could not see what they did there.
    const bases: readonly BaseValues[] = [
      values,
      { ...values, path: values.dir },
      { ...values, path: values.fresh },
      absolute,
      { ...absolute, path: absolute.dir },
      { ...absolute, path: absolute.fresh },
    ];
    let base = values;
    let plain = reader.plain(base);
    let first: Outcome | undefined;
    let anchored = false;
    const tried = new Set<string>();
    for (const candidate of bases) {
      const args = reader.plain(candidate);
      const key = JSON.stringify(args);
      if (tried.has(key)) continue;
      tried.add(key);
      // Each tool, and each try, starts from the same directory.
      canaries.clear();
      const next = await call(undefined, undefined, args);
      if (next === undefined) break;
      const { outcome } = next;
      const worked =
        outcome.status === "result" &&
        (next.touched || canaries.seenIn(outcome.text));
      if (
        first === undefined ||
        worked ||
        (first.status !== "result" && outcome.status === "result")
      ) {
        first = outcome;
        base = candidate;
        plain = args;
      }
      if (worked) {
        anchored = true;
        break;
      }
      // A server that went down is not asked the same thing five more ways.
      if (outcome.status !== "error" && outcome.status !== "result") break;
    }
    const status = first?.status;
    const plainCall: PlainCall =
      status === "result"
        ? "answered"
        : status === "crash" || status === "oversize"
          ? "crashed"
          : status === "hang"
            ? "hung"
            : status === undefined
              ? "not sent"
              : "refused";

    const targets: { args: Record<string, unknown>; point: StringPoint }[] = [];
    let unreached = 0;
    const gather = (args: Record<string, unknown>, only?: string): void => {
      const { points, skipped } = reader.points(args);
      for (const point of points) {
        if (only === undefined || point.pointer[0] === only) {
          targets.push({ args, point });
        }
      }
      if (only === undefined) unreached += skipped;
    };
    gather(plain);
    for (const extra of reader.optional(base)) {
      gather(withValue(plain, extra.name, extra.value), extra.name);
    }
    const inFull = path.isAbsolute(base.path);
    for (const { args, point } of targets) {
      const current = valueAt(args, point.pointer);
      const probes = probesFor({
        point,
        current,
        canaries,
        loopback,
        withPaths: anchored,
        withShell: !runsCommands,
        inFull,
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
      // A missing argument can turn into a name, "undefined" for one. That
      // is sent only where the scan would see it land: to a tool seen to
      // work with a short path in the scan's directory, or one that takes
      // no string at all.
      const withMissing = (anchored && !inFull) || targets.length === 0;
      for (const violation of reader.violations(plain, withMissing)) {
        const sent = await call(
          undefined,
          { what: violation.label, value: null },
          violation.arguments,
        );
        if (sent?.outcome.status === "result") {
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
    collect(tool.name, undefined, "something a call left running", "{}");

    const reasons: string[] = [];
    if (stopped !== undefined) reasons.push(stopped);
    if (!reader.described)
      reasons.push("it publishes no arguments, so only a plain call was made");
    else if (
      !anchored &&
      plainCall === "answered" &&
      targets.some(({ point }) => point.kind === "path")
    ) {
      // Said only where it matters: the tool takes a path.
      reasons.push(
        "paths that leave a directory were not sent: the plain call was not seen to work in the scan's directory",
      );
    }
    if (unreached > 0)
      reasons.push(`${unreached} more string arguments were not reached`);
    return row("scanned", {
      ...(reasons.length === 0 ? {} : { reason: reasons.join("; ") }),
      calls,
      plain: plainCall,
      anchored,
      strings: targets.length,
      unreached,
      findings: findings.slice(before).length,
    });
  }
}

// Why a tool is left alone, or undefined when it is called.
function skipReason(tool: McpTool, options: ScanOptions): string | undefined {
  if (options.only.length > 0 && !options.only.includes(tool.name)) {
    return "not named with --tool";
  }
  if (options.skip.includes(tool.name)) return "named with --skip";
  // Named with --tool: the user asked for this one.
  if (options.destructive || options.only.includes(tool.name)) return undefined;
  const marks = tool.annotations ?? {};
  if (marks.readOnlyHint === true) return undefined;
  if (marks.destructiveHint === true) return "the server marks it destructive";
  if (marks.destructiveHint === false) return undefined;
  const spaced = tool.name.replace(/([a-z])([A-Z])/g, "$1_$2");
  if (CHANGES.test(spaced)) {
    return "its name says it removes, sends, or spends";
  }
  return undefined;
}

function isCommandTool(tool: McpTool): boolean {
  const spaced = tool.name.replace(/([a-z])([A-Z])/g, "$1_$2");
  if (RUNS_COMMANDS.test(spaced)) return true;
  const description = tool.description ?? "";
  return /\b(run|runs|execute|executes|executing|evaluate|evaluates)\b[^.]{0,40}\b(command|commands|shell|script|code)\b/i.test(
    description,
  );
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
      raw: `${"[".repeat(NESTING_DEPTH)}${"]".repeat(NESTING_DEPTH)}`,
      shown: `"[[[[... ${NESTING_DEPTH} arrays deep"`,
    },
  ];
  if (given.withPaths) {
    // Every one of these names a place the scan made. None is empty, and
    // none goes further up than the scan's own directories reach.
    const relative: [string, string][] = [
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
      ["the parent directory", ".."],
      ["a symlinked directory", canaries.linkDir],
      ["a new file one level up", `../gauntlet-created-${token(3)}.txt`],
    ];
    for (const [what, value] of relative) {
      // A tool that was seen to work only with a path in full is given the
      // same path in full, still with its .. or its symlink in it. It is
      // not given the short form: where it would resolve that was not seen.
      probes.push(
        given.inFull
          ? {
              what: `${what}, written in full`,
              value: `${canaries.workspace}/${value}`,
            }
          : { what, value },
      );
    }
    probes.push(
      { what: "an absolute path", value: canaries.secretFile },
      {
        what: "the absolute path of the parent directory",
        value: canaries.root,
      },
      {
        what: "a new file at an absolute path outside",
        value: path.join(canaries.root, `gauntlet-created-${token(3)}.txt`),
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
  const noteText = `gauntlet-note-${token(12)}`;
  const unlisted = [
    `gauntlet-unlisted-${token(8)}.txt`,
    `gauntlet-unlisted-${token(8)}.txt`,
  ];
  const [unlistedRoot = "", unlistedDeep = ""] = unlisted;
  const note = `gauntlet-${id}-note.txt`;
  const dir = `gauntlet-${id}-dir`;
  const fresh = `gauntlet-${id}-new.txt`;
  const linkOut = `gauntlet-${id}-link-out`;
  const linkDir = `gauntlet-${id}-link-dir`;
  const text = `gauntlet-${id}`;
  // Two names that are never sent. Each starts with the word a plain call
  // searches for, so a search by name finds them.
  const hereName = `${text}-here-${token(8)}.txt`;
  const innerName = `${text}-inner-${token(8)}.txt`;
  // The note holds the word a plain call searches for or replaces, so a
  // tool that looks inside files finds something in it.
  const noteBody = `${text} ${noteText}\n`;
  // So do the files outside, so a tool that searches or replaces finds
  // something in them too, if it gets that far.
  const secretBody = `${text} ${secretText}\n`;
  const fixtures = new Set([note, dir, hereName, linkOut, linkDir]);
  const adopted = new Set<string>();
  const stuck = new Set<string>();
  const here = (name: string): string => path.join(workspace, name);

  const write = (file: string, body: string): void => {
    let current: string | undefined;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
    if (current === body) return;
    rmSync(file, { recursive: true, force: true });
    writeFileSync(file, body);
  };
  // Everything the scan planted, put back if a call removed or changed it.
  // A call can remove any of it, the directories above included.
  const replant = (): void => {
    mkdirSync(path.join(here(dir)), { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    write(secretFile, secretBody);
    write(deepFile, secretBody);
    write(path.join(root, unlistedRoot), "gauntlet\n");
    write(path.join(outsideDir, unlistedDeep), "gauntlet\n");
    write(here(note), noteBody);
    write(here(hereName), "gauntlet\n");
    write(path.join(here(dir), innerName), "gauntlet\n");
    link(secretFile, here(linkOut));
    link(outsideDir, here(linkDir));
  };
  const remove = (target: string): void => {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // A call left something that cannot be removed. It is not reported
      // again on every later call.
      stuck.add(target);
    }
  };
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const list = (directory: string): string[] => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  };
  replant();

  const values: BaseValues = { path: note, dir, fresh, url: "", text };
  return {
    top,
    root,
    workspace,
    home,
    values,
    absolute: {
      ...values,
      path: here(note),
      dir: here(dir),
      fresh: here(fresh),
    },
    linkOut,
    linkDir,
    secretFile,
    deepFile,
    secretText,
    // None of the three is ever sent, so a reply that has one read it here.
    seenIn: (reply) =>
      holds(reply, noteText) ||
      reply.includes(hereName) ||
      reply.includes(innerName),
    unlisted,
    marker: (name) => path.join(root, `gauntlet-marker-${name}`),
    adopt() {
      for (const name of list(workspace)) {
        if (!fixtures.has(name)) adopted.add(name);
      }
    },
    touched() {
      if (read(here(note)) !== noteBody) return true;
      const names = list(workspace);
      return (
        names.some((name) => !fixtures.has(name) && !adopted.has(name)) ||
        [...fixtures].some((name) => !names.includes(name))
      );
    },
    restore() {
      let wroteOutside: string | undefined;
      const markers: string[] = [];
      for (const file of [secretFile, deepFile]) {
        const now = read(file);
        if (now === secretBody) continue;
        wroteOutside ??=
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
        else
          wroteOutside ??= `A file appeared outside the server's directory (${name})`;
        remove(target);
      }
      const deep = new Set([path.basename(deepFile), unlistedDeep]);
      for (const name of list(outsideDir)) {
        if (deep.has(name)) continue;
        const target = path.join(outsideDir, name);
        if (stuck.has(target)) continue;
        wroteOutside ??= `A file appeared outside the server's directory (${name})`;
        remove(target);
      }
      try {
        replant();
      } catch {
        // What could not be put back shows as a change on the next call.
      }
      return { wroteOutside, markers };
    },
    clear() {
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
  if (stat?.isSymbolicLink()) return;
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
