import { randomBytes } from "node:crypto";
import {
  existsSync,
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
  type McpSession,
  type McpTool,
  openMcpSession,
  readMcpResult,
} from "../adapters/mcp.ts";
import { track } from "../cleanup.ts";
import {
  type ArgumentKind,
  asSchema,
  type BaseValues,
  baseArguments,
  optionalStrings,
  type StringPoint,
  stringPoints,
  violations,
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
  | "loopback-fetch";

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

export type ToolRow = {
  readonly name: string;
  readonly status: "scanned" | "skipped";
  // Why it was skipped, or why the scan of it stopped early.
  readonly reason?: string;
  readonly calls: number;
  // Whether a plain call with nothing odd in it got a result.
  readonly answered: boolean;
  readonly findings: number;
};

export type ScanReport = {
  readonly name: string;
  readonly server: string;
  readonly tools: readonly ToolRow[];
  readonly findings: readonly Finding[];
};

export type ScanOptions = {
  readonly command: string;
  readonly name: string;
  readonly timeoutMs: number;
  // Scan only these tools. Empty means all.
  readonly only: readonly string[];
  readonly skip: readonly string[];
  // Also call tools the server marks destructive.
  readonly destructive: boolean;
  // Variables the server is started with, on top of PATH and a temp HOME.
  readonly env: Readonly<Record<string, string>>;
  readonly maxCallsPerTool: number;
};

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
};

const NOT_TOOLS = ["constructor", "toString", "__proto__", "hasOwnProperty"];
const RAW = "__GAUNTLET_RAW_VALUE__";
const LONG_TEXT_CHARS = 200_000;
const NESTING_DEPTH = 10_000;
const MAX_RESTARTS = 3;

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
};

type Outcome =
  | { status: "result" | "error"; text: string }
  | { status: "crash" | "hang" | "bad-reply"; text: string };

// What the scan plants and then looks for. Each token is random, so it is
// in a reply only if the server put it there.
type Canaries = {
  readonly root: string;
  readonly workspace: string;
  readonly home: string;
  // A file beside the workspace. Its contents are never sent to the server.
  readonly secretFile: string;
  readonly secretText: string;
  // A second file beside the workspace. Its name is never sent, so it is in
  // a reply only if the server listed the directory.
  readonly unlisted: string;
  marker(index: number): string;
  // Puts back what a call changed, and says what that was.
  restore(): { wroteOutside: string | undefined; markers: number };
  // Empties the server's directory of what earlier calls left in it.
  clear(): void;
};

// Calls every tool an MCP server lists, with arguments made from the tool's
// own schema, and reports what the server did that it should not have.
//
// A finding is never a guess. It is a planted token in a reply, a planted
// file that changed, a marker file a payload created, or a server that
// stopped answering. A call the server merely turned down proves nothing,
// and a tool that turned down even a plain call is reported as such.
export async function scanMcp(options: ScanOptions): Promise<ScanReport> {
  const canaries = plant();
  const untrack = track(() => {
    rmSync(canaries.root, { recursive: true, force: true });
  });
  const loopback = await listen();
  // The server gets a search path and a home of its own, and nothing else
  // unless it was asked for. No token or key of the user's is in reach, and
  // a tool that writes to the home directory writes to this one.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: canaries.home,
    TMPDIR: canaries.home,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...options.env,
  };
  const open = (): Promise<McpSession> =>
    openMcpSession(options.command, canaries.workspace, options.timeoutMs, {
      env,
    });
  let session = await open();
  const findings: Finding[] = [];
  const rows: ToolRow[] = [];
  // What a plain call is made of. A tool may want its path to be a file or
  // a directory, relative or in full, and the schema rarely says which, so
  // each of these is tried until the tool gives a result.
  const here = (name: string): string => path.join(canaries.workspace, name);
  const url = loopback.url("ok");
  const bases: readonly BaseValues[] = [
    { path: "notes.txt", dir: "sub", fresh: "gauntlet-new.txt", url },
    { path: "sub", dir: "sub", fresh: "gauntlet-new", url },
    {
      path: here("notes.txt"),
      dir: here("sub"),
      fresh: here("gauntlet-new.txt"),
      url,
    },
    { path: here("sub"), dir: here("sub"), fresh: here("gauntlet-new"), url },
  ];

  const call = async (
    tool: string,
    argumentsJson: string,
  ): Promise<Outcome> => {
    const params = `{"name":${JSON.stringify(tool)},"arguments":${argumentsJson}}`;
    try {
      const reply = await session.request("tools/call", params);
      if (reply.error === undefined && (reply.result ?? null) === null) {
        return { status: "bad-reply", text: "no result and no error" };
      }
      const { text, failed } = readMcpResult(reply);
      return { status: failed ? "error" : "result", text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await session.stop();
      session = await open();
      return {
        status: message.includes("timed out") ? "hang" : "crash",
        text: message,
      };
    }
  };
  const add = (
    kind: FindingKind,
    tool: string,
    argument: string | undefined,
    detail: string,
    params: string,
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
      call: params,
      more: 0,
    });
  };
  // Everything a call can leave behind, checked after every call.
  const judge = (
    tool: string,
    argument: string | undefined,
    probe: Probe | undefined,
    argumentsJson: string,
    outcome: Outcome,
  ): void => {
    const params = `{"name":${JSON.stringify(tool)},"arguments":${shorten(argumentsJson)}}`;
    const what = probe === undefined ? "a plain call" : probe.what;
    if (outcome.status === "crash") {
      add(
        "crash",
        tool,
        argument,
        `The server exited on ${what}: ${outcome.text}`,
        params,
      );
    } else if (outcome.status === "hang") {
      add(
        "hang",
        tool,
        argument,
        `The server did not answer ${what}: ${outcome.text}`,
        params,
      );
    } else if (outcome.status === "bad-reply") {
      add(
        "bad-reply",
        tool,
        argument,
        `The reply to ${what} had ${outcome.text}.`,
        params,
      );
    }
    if (outcome.text.includes(canaries.secretText)) {
      if (probe?.viaUrl === true) {
        add(
          "url-file-read",
          tool,
          argument,
          "The reply holds the contents of a local file, read through a file:// address.",
          params,
        );
      } else {
        add(
          "outside-read",
          tool,
          argument,
          `The reply holds the contents of a file outside the server's directory, reached with ${what}.`,
          params,
        );
      }
    }
    if (outcome.text.includes(canaries.unlisted)) {
      add(
        "outside-list",
        tool,
        argument,
        `The reply names a file outside the server's directory, which only a listing of that directory shows. It was reached with ${what}.`,
        params,
      );
    }
    const left = canaries.restore();
    if (left.wroteOutside !== undefined) {
      add(
        "outside-write",
        tool,
        argument,
        `${left.wroteOutside}, with ${what}.`,
        params,
      );
    }
    if (left.markers > 0) {
      add(
        "shell-injection",
        tool,
        argument,
        `A command inside the argument ran: ${what} created the marker file it names.`,
        params,
      );
    }
    if (loopback.take() && probe?.viaUrl !== true && probe !== undefined) {
      add(
        "loopback-fetch",
        tool,
        argument,
        "The server fetched an address on this machine that the argument gave it.",
        params,
      );
    }
  };

  try {
    // Names that are on every object, and one that is on none. A server
    // that answers any of them is not looking tools up in its own list.
    const answered: string[] = [];
    for (const name of [...NOT_TOOLS, `gauntlet-no-such-tool-${token(4)}`]) {
      const outcome = await call(name, "{}");
      if (outcome.status === "result") answered.push(name);
      canaries.restore();
      loopback.take();
    }
    const [phantom] = answered;
    if (phantom !== undefined) {
      add(
        "phantom-tool",
        phantom,
        undefined,
        `The server answered a call to ${answered.map((name) => `"${name}"`).join(", ")}, which ${answered.length === 1 ? "is" : "are"} not in its list of tools.`,
        `{"name":${JSON.stringify(phantom)},"arguments":{}}`,
      );
    }
    for (const tool of session.toolList) {
      rows.push(await scanTool(tool));
    }
  } finally {
    await session.stop();
    await loopback.close();
    untrack();
    rmSync(canaries.root, { recursive: true, force: true, maxRetries: 3 });
  }
  return {
    name: options.name,
    server: session.serverInfo,
    tools: rows,
    findings,
  };

  async function scanTool(tool: McpTool): Promise<ToolRow> {
    const skipped = (reason: string): ToolRow => ({
      name: tool.name,
      status: "skipped",
      reason,
      calls: 0,
      answered: false,
      findings: 0,
    });
    if (options.only.length > 0 && !options.only.includes(tool.name)) {
      return skipped("not named with --tool");
    }
    if (options.skip.includes(tool.name)) return skipped("named with --skip");
    if (tool.annotations?.destructiveHint === true && !options.destructive) {
      return skipped("the server marks it destructive");
    }
    const before = findings.length;
    const schema = asSchema(tool.inputSchema);
    let calls = 0;
    let restarts = 0;
    let stopped: string | undefined;
    const send = async (
      argument: string | undefined,
      probe: Probe | undefined,
      args: Record<string, unknown>,
    ): Promise<Outcome | undefined> => {
      if (stopped !== undefined) return undefined;
      if (calls >= options.maxCallsPerTool) {
        stopped = `stopped after ${options.maxCallsPerTool} calls`;
        return undefined;
      }
      calls += 1;
      const text = JSON.stringify(args);
      const argumentsJson =
        probe?.raw === undefined
          ? text
          : text.replace(JSON.stringify(RAW), () => probe.raw ?? "null");
      const outcome = await call(tool.name, argumentsJson);
      // The report prints a short stand-in for a value nobody would read.
      const printed =
        probe?.shown === undefined
          ? argumentsJson
          : text.replace(
              JSON.stringify(probe.raw === undefined ? probe.value : RAW),
              () => probe.shown ?? "",
            );
      judge(tool.name, argument, probe, printed, outcome);
      if (outcome.status === "crash" || outcome.status === "hang") {
        restarts += 1;
        if (restarts >= MAX_RESTARTS) {
          stopped = `stopped after the server went down ${MAX_RESTARTS} times`;
        }
      }
      return outcome;
    };

    // Each tool starts from the same directory, so a file one tool made is
    // not in the way of the next.
    canaries.clear();
    // A plain call first, in each form a path can take, until one works.
    const [firstBase = bases[0]] = bases;
    if (!firstBase) throw new Error("no base values");
    let base = firstBase;
    let plain = baseArguments(schema, base);
    let first = await send(undefined, undefined, plain);
    const tried = new Set([JSON.stringify(plain)]);
    for (const candidate of bases.slice(1)) {
      if (first?.status !== "error") break;
      const args = baseArguments(schema, candidate);
      if (tried.has(JSON.stringify(args))) continue;
      tried.add(JSON.stringify(args));
      canaries.clear();
      const next = await send(undefined, undefined, args);
      if (next?.status === "result") {
        base = candidate;
        plain = args;
        first = next;
      }
    }
    const answered = first?.status === "result";

    const targets: { args: Record<string, unknown>; point: StringPoint }[] = [];
    for (const point of stringPoints(plain, schema)) {
      targets.push({ args: plain, point });
    }
    for (const extra of optionalStrings(schema, base)) {
      const args = withValue(plain, extra.name, extra.value);
      for (const point of stringPoints(args, schema)) {
        if (point.pointer[0] === extra.name) targets.push({ args, point });
      }
    }
    let marker = 0;
    for (const { args, point } of targets) {
      const current = valueAt(args, point.pointer);
      const probes = probesFor(point.kind, current, canaries, loopback, () => {
        marker += 1;
        return canaries.marker(marker);
      });
      for (const probe of probes) {
        const value = probe.raw === undefined ? probe.value : RAW;
        await send(point.label, probe, withString(args, point.pointer, value));
      }
    }

    // Calls the schema forbids. One that gets a result was not checked
    // against the schema the server published.
    const accepted: string[] = [];
    let example = "";
    for (const violation of violations(schema, plain)) {
      const outcome = await send(
        undefined,
        { what: violation.label, value: null },
        violation.arguments,
      );
      if (outcome?.status === "result") {
        accepted.push(violation.label);
        if (example.length === 0) example = JSON.stringify(violation.arguments);
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
    return {
      name: tool.name,
      status: "scanned",
      ...(stopped === undefined ? {} : { reason: stopped }),
      calls,
      answered,
      findings: findings.length - before,
    };
  }
}

function probesFor(
  kind: ArgumentKind,
  current: unknown,
  canaries: Canaries,
  loopback: Loopback,
  nextMarker: () => string,
): Probe[] {
  const secretName = path.basename(canaries.secretFile);
  const stem =
    typeof current === "string" && current.length > 0 ? current : "gauntlet";
  const probes: Probe[] = [
    { what: "a path that starts with ../", value: `../${secretName}` },
    { what: "an absolute path", value: canaries.secretFile },
    {
      what: "a path that goes down and back up",
      value: `sub/../../${secretName}`,
    },
    { what: "a symlink that points outside", value: "link-out" },
    {
      what: "a path through a symlinked directory",
      value: `link-dir/${secretName}`,
    },
    { what: "the parent directory", value: ".." },
    { what: "the absolute path of the parent directory", value: canaries.root },
    { what: "a symlinked directory", value: "link-dir" },
    {
      what: "a new file one level up",
      value: `../gauntlet-created-${token(3)}.txt`,
    },
    {
      what: "a new file at an absolute path outside",
      value: path.join(canaries.root, `gauntlet-created-${token(3)}.txt`),
    },
    { what: "a NUL byte in the value", value: "notes.txt\u0000.md" },
    { what: "an empty string", value: "" },
    {
      what: `a string of ${LONG_TEXT_CHARS} characters`,
      value: "A".repeat(LONG_TEXT_CHARS),
      shown: `"AAAA... ${LONG_TEXT_CHARS} characters"`,
    },
    { what: "control characters", value: "gauntlet\u0007\u001b[2J\u0085" },
    { what: "a lone surrogate", value: null, raw: '"gauntlet\\ud800"' },
    {
      what: `${NESTING_DEPTH} nested arrays where a string goes`,
      value: null,
      raw: `${"[".repeat(NESTING_DEPTH)}${"]".repeat(NESTING_DEPTH)}`,
      shown: `"[[[[... ${NESTING_DEPTH} arrays deep"`,
    },
  ];
  // A value that is a command by design runs whatever it is given. That is
  // the tool's job and not an injection.
  if (kind !== "command") {
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
      probes.push({ what, value: build(nextMarker()) });
    }
  }
  if (kind === "url") {
    probes.push(
      {
        what: "a file:// address",
        value: `file://${canaries.secretFile}`,
        viaUrl: true,
      },
      {
        what: "an address on this machine",
        value: loopback.url(`gauntlet-${token(4)}`),
      },
    );
  }
  return probes;
}

function plant(): Canaries {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "gauntlet-scan-")),
  );
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const secretFile = path.join(root, `gauntlet-outside-${token(4)}.txt`);
  const secretText = `gauntlet-secret-${token(8)}`;
  const unlisted = `gauntlet-unlisted-${token(8)}.txt`;
  const kept = new Set([
    "workspace",
    "home",
    path.basename(secretFile),
    unlisted,
  ]);
  const fixtures = (): void => {
    mkdirSync(path.join(workspace, "sub"), { recursive: true });
    mkdirSync(home, { recursive: true });
    const note = path.join(workspace, "notes.txt");
    if (!existsSync(note)) writeFileSync(note, "gauntlet note\n");
    const inner = path.join(workspace, "sub", "inner.txt");
    if (!existsSync(inner)) writeFileSync(inner, "gauntlet inner\n");
    link(secretFile, path.join(workspace, "link-out"));
    link(root, path.join(workspace, "link-dir"));
    if (!existsSync(path.join(root, unlisted))) {
      writeFileSync(path.join(root, unlisted), "gauntlet\n");
    }
  };
  writeFileSync(secretFile, `${secretText}\n`);
  fixtures();
  return {
    root,
    workspace,
    home,
    secretFile,
    secretText,
    unlisted,
    marker: (index) => path.join(root, `gauntlet-marker-${index}`),
    clear() {
      for (const name of readdirSync(workspace)) {
        rmSync(path.join(workspace, name), { recursive: true, force: true });
      }
      fixtures();
    },
    restore() {
      let wroteOutside: string | undefined;
      let markers = 0;
      let secret: string | undefined;
      try {
        secret = readFileSync(secretFile, "utf8");
      } catch {
        secret = undefined;
      }
      if (secret !== `${secretText}\n`) {
        wroteOutside =
          secret === undefined
            ? "A file outside the server's directory was deleted"
            : "A file outside the server's directory was overwritten";
        rmSync(secretFile, { recursive: true, force: true });
        writeFileSync(secretFile, `${secretText}\n`);
      }
      for (const name of readdirSync(root)) {
        if (kept.has(name)) continue;
        if (name.startsWith("gauntlet-marker-")) markers += 1;
        else
          wroteOutside ??= `A file appeared outside the server's directory (${name})`;
        rmSync(path.join(root, name), { recursive: true, force: true });
      }
      fixtures();
      return { wroteOutside, markers };
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
  // Whether anything asked for an address since the last take.
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
