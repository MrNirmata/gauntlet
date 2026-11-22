import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameTopLevelKeys, splitCall } from "../structured.ts";
import type { Adapter, RunOutput, ToolCall } from "../types.ts";

// The newest revision this client was written against. A server answers
// initialize with the revision it will speak, and tools/list and tools/call
// have the same shape in every revision so far.
const PROTOCOL_VERSION = "2025-06-18";
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const SNIPPET_LIMIT = 200;
const STOP_WAIT_MS = 1000;
const MAX_TOOL_PAGES = 20;

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
// calls them.
export function mcpAdapter(
  command: string,
  timeoutMs: number,
  name: string,
  toolNames: ReadonlyMap<string, string>,
  argumentNames: ReadonlyMap<string, string> = new Map(),
): Adapter {
  let session: Session | undefined;
  const stop = async (): Promise<void> => {
    const current = session;
    session = undefined;
    await current?.stop();
  };
  return {
    name,
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
      if (session?.workspace !== input.sandboxDir) {
        await stop();
        session = await startSession(command, input.sandboxDir, timeoutMs);
      }
      const mapped = toolNames.get(split.call.name);
      const offered =
        split.call.name === "read_file" || split.call.name === "write_file";
      if (offered && !session.tools.has(mapped ?? split.call.name)) {
        return notCovered(
          `the server has no tool named ${mapped ?? split.call.name}`,
        );
      }
      // The arguments go out as the scenario wrote them. Parsing and
      // printing them again would drop a __proto__ key and unescape a lone
      // surrogate before the server ever saw either.
      const nameJson =
        mapped === undefined ? split.nameJson : JSON.stringify(mapped);
      const reply = await session.request(
        "tools/call",
        `{"name":${nameJson},"arguments":${renameTopLevelKeys(split.argumentsJson, argumentNames)}}`,
      );
      return toRunOutput(reply, split.call);
    },
    close: stop,
  };
}

// Starts the server once in an empty directory and returns the names of its
// tools. A run asks this first, so a command that cannot start, or a server
// whose tools have other names, is one clear message and not the same error
// on every row.
export async function listMcpTools(
  command: string,
  timeoutMs: number,
): Promise<string[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-mcp-"));
  try {
    const session = await startSession(command, dir, timeoutMs);
    await session.stop();
    return [...session.tools];
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function toRunOutput(reply: Reply, call: ToolCall): RunOutput {
  if (reply.error !== undefined) {
    return { status: "refused", reason: firstLine(reply.error.message) };
  }
  const result = reply.result;
  const text = resultText(result);
  // A tool that turns a call down says so with isError. So does a tool that
  // tried and failed. Either way nothing was done, which is a refusal here.
  if (isRecord(result) && result.isError === true) {
    return {
      status: "refused",
      reason: firstLine(text.length > 0 ? text : "the tool reported an error"),
    };
  }
  return { status: "executed", call, result: text };
}

function resultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  const parts: string[] = [];
  for (const block of result.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
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
  const line = command
    .replaceAll("{workspace}", shellQuote(real))
    .replaceAll("{cwd}", shellQuote(process.cwd()));
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
    if (typeof id !== "number") return;
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    clearTimeout(waiting.timer);
    const error = message.error;
    if (isRecord(error)) {
      waiting.resolve({
        error: {
          message: typeof error.message === "string" ? error.message : "error",
        },
      });
      return;
    }
    waiting.resolve({ result: message.result });
  };

  stdout.setEncoding("utf8");
  errors.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) receive(line);
    }
    if (buffer.length > MAX_BUFFER_CHARS) {
      killGroup(child);
      end(`mcp server sent a message over ${MAX_BUFFER_CHARS} bytes`);
    }
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
      const how =
        code === null ? `signal ${signal ?? "unknown"}` : String(code);
      end(withSnippet(`mcp server exited ${how}`, stderr));
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    end("mcp server stopped");
    killGroup(child);
    stdin.destroy();
    let timer: NodeJS.Timeout | undefined;
    // The server's directory is the sandbox. Wait for it to be gone, so the
    // sandbox can be deleted, but not for longer than this.
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
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
    if (!isRecord(result) || !Array.isArray(result.tools)) break;
    for (const tool of result.tools) {
      if (isRecord(tool) && typeof tool.name === "string") names.add(tool.name);
    }
    if (typeof result.nextCursor !== "string") break;
    cursor = result.nextCursor;
  }
  return names;
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
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
