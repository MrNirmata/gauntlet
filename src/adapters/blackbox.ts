import { type ChildProcess, spawn } from "node:child_process";
import { asRunOutput } from "../output.ts";
import type { Adapter, AdapterRunInput, RunOutput } from "../types.ts";

const SNIPPET_LIMIT = 200;
// A probe reply is one small JSON object. A program that keeps printing is
// stopped here, before its output fills memory.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

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
      if (stdout.length <= MAX_OUTPUT_BYTES) return;
      killChild(child);
      fail(`exec output exceeded ${MAX_OUTPUT_BYTES} bytes`);
    });
    stderrStream.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
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
  let text: string;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(probeMessage(input)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await readBody(response);
  } catch (error) {
    if (error instanceof OversizedBody) throw new Error(error.message);
    if (isTimeout(error)) {
      throw new Error(`http timed out after ${timeoutMs}ms`);
    }
    throw new Error(`http request failed: ${firstLine(errorText(error))}`);
  }
  if (!response.ok) {
    throw new Error(withSnippet(`http responded ${response.status}`, text));
  }
  const read = readOutput(text);
  if (!read.ok) throw new Error(withSnippet(`http ${read.reason}`, text));
  return read.output;
}

class OversizedBody extends Error {}

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_OUTPUT_BYTES) {
      await reader.cancel();
      throw new OversizedBody(
        `http response exceeded ${MAX_OUTPUT_BYTES} bytes`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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
