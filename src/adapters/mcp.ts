import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { track } from "../cleanup.ts";
import { renameTopLevelKeys, splitCall } from "../structured.ts";
import type { Adapter, RunOutput, ToolCall } from "../types.ts";

// The newest revision this client was written against. A server answers
// initialize with the revision it will speak, and tools/list and tools/call
// have the same shape in every revision so far.
const PROTOCOL_VERSION = "2025-06-18";
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
// A refusal keeps its whole text, because a scenario looks in it for bytes
// that should not have come back. This is the most it keeps.
const MAX_REASON_CHARS = 64 * 1024;
const SNIPPET_LIMIT = 200;
const EXIT_DRAIN_MS = 250;
const POLITE_STOP_MS = 200;
const STOP_WAIT_MS = 1000;
const MAX_TOOL_PAGES = 20;
const CONTROL_FILE = "gauntlet-control.txt";
const CONTROL_TEXT = "gauntlet control\n";

type Reply = {
  result?: unknown;
  error?: { message: string };
};

type Pending = {
  resolve(reply: Reply): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

type Session = {
  readonly workspace: string;
  readonly tools: ReadonlySet<string>;
  request(method: string, paramsJson?: string): Promise<Reply>;
  stop(): Promise<void>;
};

export type McpCheck = {
  // Every tool the server lists.
  readonly tools: readonly string[];
  // Why the server cannot be tested. Absent when it can.
  readonly problem?: string;
  // Something the run goes on without.
  readonly note?: string;
};

export type McpAdapter = Adapter & {
  // Starts the server once in an empty directory, lists its tools, and asks
  // it to write a file and read it back. The answer is kept, and every probe
  // waits for it.
  check(): Promise<McpCheck>;
};

// Tests an MCP server over stdio. Gauntlet is the client: it starts the
// server once per scenario, with the scenario's workspace as its directory,
// and sends each probe as a tools/call request.
//
// The server runs in the workspace, not where Gauntlet was started. A path
// in a probe is relative, and a server that resolved it against a project
// directory would be reading and writing that project.
//
// `{workspace}` in the command is replaced by the path of that directory,
// and `{cwd}` by the directory Gauntlet was started in, for a server that is
// a file there. toolNames maps read_file and write_file to what the server
// calls them, and argumentNames does the same for path and content.
export function mcpAdapter(
  command: string,
  timeoutMs: number,
  name: string,
  toolNames: ReadonlyMap<string, string>,
  argumentNames: ReadonlyMap<string, string> = new Map(),
): McpAdapter {
  let session: Session | undefined;
  let starting: Promise<Session> | undefined;
  let checked: Promise<McpCheck> | undefined;
  // Counts closes. A call that finds the count changed was closed meanwhile.
  let stops = 0;

  // Stops whatever server there is, and the one still starting, if any.
  const release = async (): Promise<void> => {
    const current = session;
    const pending = starting;
    session = undefined;
    await current?.stop();
    if (pending) {
      try {
        await (await pending).stop();
      } catch {
        // It never started.
      }
    }
  };
  const close = async (): Promise<void> => {
    stops += 1;
    await release();
  };
  // A close can arrive while a call is still under way: the runner gives up
  // on a call that takes too long and closes the adapter. The call must not
  // go on to start a server nobody will stop.
  const stillOpen = (mine: number): void => {
    if (stops !== mine) throw new Error("mcp adapter was closed during a call");
  };
  const callJson = (tool: string, args: string): string =>
    `{"name":${JSON.stringify(tool)},"arguments":${renameTopLevelKeys(args, argumentNames)}}`;
  const check = (): Promise<McpCheck> => {
    checked ??= controlRun(command, timeoutMs, toolNames, callJson);
    return checked;
  };

  return {
    name,
    check,
    async run(input) {
      if (input.aborted) {
        return notCovered(
          "the client drops an aborted call before a server sees it",
        );
      }
      const split = input.call === undefined ? undefined : splitCall(input.raw);
      if (!split) {
        return notCovered(
          "an MCP server receives parsed calls, not raw model text",
        );
      }
      // A server that turns every call down for a reason of its own, such as
      // an argument it calls by another name, would pass every scenario that
      // expects a refusal. Nothing is scored until it has written a file and
      // read it back.
      const mine = stops;
      const control = await check();
      stillOpen(mine);
      if (control.problem !== undefined) throw new Error(control.problem);
      if (session?.workspace !== input.sandboxDir) {
        await release();
        stillOpen(mine);
        starting = startSession(command, input.sandboxDir, timeoutMs);
        let started: Session;
        try {
          started = await starting;
        } finally {
          starting = undefined;
        }
        if (stops !== mine) {
          await started.stop();
          stillOpen(mine);
        }
        session = started;
      }
      const mapped = toolNames.get(split.call.name);
      const offered =
        split.call.name === "read_file" || split.call.name === "write_file";
      if (offered && !session.tools.has(mapped ?? split.call.name)) {
        return notCovered(
          `the server has no tool named ${mapped ?? split.call.name}`,
        );
      }
      // The arguments go out as the text the scenario wrote. Whatever a
      // reprint would or would not change, the server then sees exactly what
      // the scenario says it sends.
      const reply = await session.request(
        "tools/call",
        callJson(mapped ?? split.call.name, split.argumentsJson),
      );
      return toRunOutput(reply, split.call);
    },
    close,
  };
}

async function controlRun(
  command: string,
  timeoutMs: number,
  toolNames: ReadonlyMap<string, string>,
  callJson: (tool: string, args: string) => string,
): Promise<McpCheck> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-mcp-"));
  let session: Session | undefined;
  try {
    try {
      session = await startSession(command, dir, timeoutMs);
    } catch (error) {
      return {
        tools: [],
        problem: `could not start the MCP server: ${errorText(error)}`,
      };
    }
    const tools = [...session.tools];
    const read = toolNames.get("read_file") ?? "read_file";
    const write = toolNames.get("write_file") ?? "write_file";
    const offered = tools.length > 0 ? tools.join(", ") : "none";
    const canRead = session.tools.has(read);
    const canWrite = session.tools.has(write);
    if (!canRead && !canWrite) {
      return {
        tools,
        problem: `the MCP server has no tool named ${read} or ${write}. Its tools: ${offered}. Name the one that reads a file with --tool read_file=<name> and the one that writes with --tool write_file=<name>`,
      };
    }
    const hint =
      "Gauntlet sends a path relative to the server's directory. Check --tool and --arg";
    const file = path.join(dir, CONTROL_FILE);
    if (canWrite) {
      const reply = await session.request(
        "tools/call",
        callJson(
          write,
          JSON.stringify({ path: CONTROL_FILE, content: CONTROL_TEXT }),
        ),
      );
      const output = toRunOutput(reply, { name: write, arguments: {} });
      if (output.status !== "executed" || readOrEmpty(file) !== CONTROL_TEXT) {
        return {
          tools,
          problem: `the MCP server did not write a file in its own directory with ${write}: ${controlReason(output)}. ${hint}`,
        };
      }
    }
    if (canRead) {
      writeFileSync(file, CONTROL_TEXT);
      const reply = await session.request(
        "tools/call",
        callJson(read, JSON.stringify({ path: CONTROL_FILE })),
      );
      const output = toRunOutput(reply, { name: read, arguments: {} });
      if (
        output.status !== "executed" ||
        !output.result.includes(CONTROL_TEXT.trim())
      ) {
        return {
          tools,
          problem: `the MCP server did not read a file in its own directory with ${read}: ${controlReason(output)}. ${hint}`,
        };
      }
    }
    if (canRead && canWrite) return { tools };
    return {
      tools,
      note: `the MCP server has no tool named ${canRead ? write : read}. Its tools: ${offered}. Scenarios that need it are not covered`,
    };
  } catch (error) {
    return {
      tools: [],
      problem: `the MCP server failed its first call: ${errorText(error)}`,
    };
  } finally {
    await session?.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function controlReason(output: RunOutput): string {
  if (output.status === "executed") return "the file is not there";
  return firstLine(output.reason).slice(0, SNIPPET_LIMIT);
}

function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function toRunOutput(reply: Reply, call: ToolCall): RunOutput {
  if (reply.error !== undefined) {
    return { status: "refused", reason: clip(reply.error.message) };
  }
  const result = reply.result;
  if (result === undefined || result === null) {
    throw new Error("mcp tools/call reply had no result and no error");
  }
  const text = resultText(result);
  // A tool that turns a call down says so with isError. So does a tool that
  // tried and failed. Both are a refusal here. The text stays whole: it goes
  // back to the model like any other result, so a scenario still looks in it
  // for bytes that should not have come back.
  if (isRecord(result) && result.isError === true) {
    return {
      status: "refused",
      reason: text.length > 0 ? clip(text) : "the tool reported an error",
    };
  }
  return { status: "executed", call, result: text };
}

// Text from every block that carries some: a text block, and a resource
// block with the file embedded. A reply with only structuredContent is
// printed as JSON.
function resultText(result: unknown): string {
  if (!isRecord(result)) return "";
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (
        block.type === "resource" &&
        isRecord(block.resource) &&
        typeof block.resource.text === "string"
      ) {
        parts.push(block.resource.text);
      }
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent);
    } catch {
      return "";
    }
  }
  return parts.join("\n");
}

async function startSession(
  command: string,
  sandboxDir: string,
  timeoutMs: number,
): Promise<Session> {
  // The server gets the path the system itself uses. On macOS a temp
  // directory is reached through a symlink, and a server that compares real
  // paths would otherwise find its own workspace outside what it was given.
  const real = realpathSync(sandboxDir);
  // A function, not a string: in a replacement string `$&` and `$'` mean
  // something, and a path may hold either.
  const line = command
    .replaceAll("{workspace}", () => shellQuote(real))
    .replaceAll("{cwd}", () => shellQuote(process.cwd()));
  const child = spawn(line, {
    shell: true,
    cwd: real,
    detached: true,
    stdio: "pipe",
  });
  const { stdin, stdout, stderr: errors } = child;
  if (stdin === null || stdout === null || errors === null) {
    killGroup(child);
    throw new Error("mcp server failed: missing stdio");
  }
  const untrack = track(() => killGroup(child));
  const pending = new Map<number, Pending>();
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let ended: string | undefined;

  const end = (reason: string): void => {
    if (ended !== undefined) return;
    ended = reason;
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
    pending.clear();
  };
  const send = (text: string): void => {
    if (ended === undefined) stdin.write(`${text}\n`);
  };
  const settle = (id: number, reply: Reply): void => {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(reply);
  };
  const receive = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Not a message. Some servers print a banner on stdout.
      return;
    }
    if (!isRecord(message)) return;
    const id = message.id;
    if (typeof message.method === "string") {
      // A request from the server. This client offers no capabilities, so
      // the only one it can answer is ping.
      if (id === undefined || id === null) return;
      send(
        message.method === "ping"
          ? `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{}}`
          : `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"error":{"code":-32601,"message":"Method not found"}}`,
      );
      return;
    }
    const error = isRecord(message.error)
      ? {
          error: {
            message:
              typeof message.error.message === "string"
                ? message.error.message
                : "error",
          },
        }
      : undefined;
    // A server that could not parse a request cannot say which one it was,
    // and answers with a null id. One request is waiting, so it is that one.
    if (error && (id === null || id === undefined) && pending.size === 1) {
      const [only] = pending.keys();
      if (only !== undefined) settle(only, error);
      return;
    }
    if (typeof id !== "number") return;
    settle(id, error ?? { result: message.result });
  };
  const drain = (): void => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) receive(line);
    }
  };

  stdout.setEncoding("utf8");
  errors.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    drain();
    if (buffer.length > MAX_BUFFER_CHARS) {
      killGroup(child);
      end(`mcp server sent a message over ${MAX_BUFFER_CHARS} bytes`);
    }
  });
  // A last message with no newline after it is still a message.
  stdout.on("end", () => {
    const rest = buffer.trim();
    buffer = "";
    if (rest.length > 0) receive(rest);
  });
  errors.on("data", (chunk: string) => {
    if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
  });
  stdin.on("error", () => {
    // The server closed its input. exit reports why.
  });
  child.on("error", (error) => {
    end(withSnippet(`mcp server failed: ${firstLine(error.message)}`, stderr));
  });
  const exited = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      untrack();
      resolve();
      const how =
        code === null ? `signal ${signal ?? "unknown"}` : String(code);
      // What the server printed last may still be on its way.
      setTimeout(() => {
        end(withSnippet(`mcp server exited ${how}`, stderr));
      }, EXIT_DRAIN_MS).unref();
      stdout.once("close", () => {
        end(withSnippet(`mcp server exited ${how}`, stderr));
      });
    });
  });
  const wait = (ms: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  // Close the input and give the server a moment to leave on its own, the
  // way a client is asked to. Then kill its group. The server's directory is
  // the sandbox, so this waits for it to be gone before the sandbox is
  // deleted, but not for long.
  const stop = async (): Promise<void> => {
    end("mcp server stopped");
    stdin.end();
    await wait(POLITE_STOP_MS);
    killGroup(child);
    await wait(STOP_WAIT_MS);
    untrack();
    stdin.destroy();
    stdout.destroy();
    errors.destroy();
  };

  const request = (method: string, paramsJson?: string): Promise<Reply> => {
    if (ended !== undefined) return Promise.reject(new Error(ended));
    const id = nextId;
    nextId += 1;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // A server that did not answer one request is not asked another.
        killGroup(child);
        end(`mcp ${method} timed out after ${timeoutMs}ms`);
        reject(new Error(`mcp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const params = paramsJson === undefined ? "" : `,"params":${paramsJson}`;
      send(
        `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)}${params}}`,
      );
    });
  };

  try {
    const hello = await request(
      "initialize",
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "gauntlet", version: "0" },
      }),
    );
    if (hello.error !== undefined) {
      throw new Error(
        `mcp initialize failed: ${firstLine(hello.error.message)}`,
      );
    }
    if (!isRecord(hello.result)) {
      throw new Error("mcp initialize reply had no result");
    }
    send('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    const tools = await listTools(request);
    return { workspace: sandboxDir, tools, request, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function listTools(
  request: Session["request"],
): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const reply = await request(
      "tools/list",
      cursor === undefined ? undefined : JSON.stringify({ cursor }),
    );
    if (reply.error !== undefined) {
      throw new Error(
        `mcp tools/list failed: ${firstLine(reply.error.message)}`,
      );
    }
    const result = reply.result;
    if (!isRecord(result) || !Array.isArray(result.tools)) return names;
    for (const tool of result.tools) {
      if (isRecord(tool) && typeof tool.name === "string") names.add(tool.name);
    }
    if (typeof result.nextCursor !== "string") return names;
    cursor = result.nextCursor;
  }
  // A list that never ends is not a list of the server's tools.
  throw new Error(`mcp tools/list did not end after ${MAX_TOOL_PAGES} pages`);
}

function notCovered(reason: string): RunOutput {
  return { status: "not-covered", reason };
}

// `shell: true` runs sh, and the server is sh's child. Killing the process
// group reaches the server and anything it started.
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || pid === process.pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", () => "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string): string {
  return text.length <= MAX_REASON_CHARS
    ? text
    : text.slice(0, MAX_REASON_CHARS);
}

function errorText(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error));
}

function withSnippet(reason: string, extra: string): string {
  const flat = extra.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return reason;
  return `${reason}: ${flat.slice(0, SNIPPET_LIMIT)}`;
}

function firstLine(text: string): string {
  const line = text.split(/\r\n|\r|\n/)[0]?.trim();
  return line !== undefined && line.length > 0 ? line : "unknown error";
}
