import { type ChildProcess, spawn } from "node:child_process";
import type {
  Adapter,
  AdapterRunInput,
  RunOutput,
  ToolCall,
} from "../types.ts";

const SNIPPET_LIMIT = 200;

export function execAdapter(
  command: string,
  timeoutMs: number,
  name: string,
): Adapter {
  return {
    name,
    run(input) {
      return runCommand(command, input, timeoutMs);
    },
  };
}

export function httpAdapter(
  url: string,
  timeoutMs: number,
  name: string,
): Adapter {
  return {
    name,
    run(input) {
      return runHttp(url, input, timeoutMs);
    },
  };
}

function runCommand(
  command: string,
  input: AdapterRunInput,
  timeoutMs: number,
): Promise<RunOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: process.cwd(),
      detached: true,
      stdio: "pipe",
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdin = child.stdin;
    if (stdoutStream === null || stderrStream === null || stdin === null) {
      killChild(child);
      reject(new Error("exec failed: missing stdio"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    const succeed = (output: RunOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };
    child.on("error", (error) => {
      if (timedOut) return;
      fail(withSnippet(`exec failed: ${firstLine(error.message)}`, stderr));
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        fail(withSnippet(`exec timed out after ${timeoutMs}ms`, stderr));
        return;
      }
      if (code !== 0) {
        const how =
          code === null ? `signal ${signal ?? "unknown"}` : String(code);
        fail(withSnippet(`exec exited ${how}`, stderr));
        return;
      }
      const read = readOutput(stdout);
      if (!read.ok) {
        fail(withSnippet(`exec ${read.reason}`, stderr));
        return;
      }
      succeed(read.output);
    });
    stdin.on("error", () => {
      // The process closed stdin early. close reports the exit status.
    });
    stdin.end(`${JSON.stringify(probeMessage(input))}\n`);
  });
}

async function runHttp(
  url: string,
  input: AdapterRunInput,
  timeoutMs: number,
): Promise<RunOutput> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(probeMessage(input)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new Error(`http timed out after ${timeoutMs}ms`);
    }
    throw new Error(`http request failed: ${firstLine(errorText(error))}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(withSnippet(`http responded ${response.status}`, text));
  }
  const read = readOutput(text);
  if (!read.ok) throw new Error(withSnippet(`http ${read.reason}`, text));
  return read.output;
}

function probeMessage(input: AdapterRunInput): AdapterRunInput {
  return {
    raw: input.raw,
    sandboxDir: input.sandboxDir,
    aborted: input.aborted,
  };
}

type OutputRead =
  | { ok: true; output: RunOutput }
  | { ok: false; reason: string };

function readOutput(text: string): OutputRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "output was not valid JSON" };
  }
  const output = asRunOutput(value);
  if (!output) return { ok: false, reason: "output was not a RunOutput" };
  return { ok: true, output };
}

function asRunOutput(value: unknown): RunOutput | undefined {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return undefined;
  }
  if (value.status === "executed") {
    if (!("call" in value) || !("result" in value)) return undefined;
    if (typeof value.result !== "string") return undefined;
    const call = asToolCall(value.call);
    if (!call) return undefined;
    return { status: "executed", call, result: value.result };
  }
  if (value.status === "refused" || value.status === "not-covered") {
    if (!("reason" in value) || typeof value.reason !== "string")
      return undefined;
    return { status: value.status, reason: value.reason };
  }
  return undefined;
}

function asToolCall(value: unknown): ToolCall | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("name" in value) || typeof value.name !== "string") return undefined;
  if (!("arguments" in value)) return undefined;
  const args = value.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  const argumentsRecord: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(args)) {
    argumentsRecord[key] = entry;
  }
  return { name: value.name, arguments: argumentsRecord };
}

// `shell: true` runs sh, and the command is sh's child. Killing the
// process group reaches that child when the probe times out.
function killChild(child: ChildProcess): void {
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

function withSnippet(reason: string, extra: string): string {
  const text = snippet(extra);
  if (text.length === 0) return reason;
  return `${reason}: ${text}`;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_LIMIT ? flat : flat.slice(0, SNIPPET_LIMIT);
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("name" in error && error.name === "TimeoutError") return true;
  if ("cause" in error) return isTimeout(error.cause);
  return false;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim();
  return line !== undefined && line.length > 0 ? line : "unknown error";
}
