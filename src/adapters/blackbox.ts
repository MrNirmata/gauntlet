import { type ChildProcess, spawn } from "node:child_process";
import { track } from "../cleanup.ts";
import { asRunOutput } from "../output.ts";
import { splitCall } from "../structured.ts";
import type { Adapter, AdapterRunInput, RunOutput } from "../types.ts";

const SNIPPET_LIMIT = 200;
// A probe reply is one small JSON object. A program that keeps printing is
// stopped here, before its output fills memory.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const EXIT_DRAIN_MS = 250;

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
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    // Settling lets go of everything: both timers and all three pipes. A
    // grandchild that outlives the command can hold a pipe open for as long
    // as it likes, and that must not hold the probe.
    const untrack = track(() => killChild(child));
    const release = (): void => {
      settled = true;
      untrack();
      clearTimeout(timer);
      clearTimeout(drain);
      stdoutStream.destroy();
      stderrStream.destroy();
      stdin.destroy();
    };
    const fail = (message: string): void => {
      if (settled) return;
      release();
      reject(new Error(message));
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
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
      release();
      resolve(read.output);
    };
    // The timer settles the probe itself. Waiting for the pipes to close
    // would wait on whoever still holds them.
    const timer = setTimeout(() => {
      killChild(child);
      fail(withSnippet(`exec timed out after ${timeoutMs}ms`, stderr));
    }, timeoutMs);
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= MAX_OUTPUT_BYTES) return;
      killChild(child);
      fail(`exec output exceeded ${MAX_OUTPUT_BYTES} bytes`);
    });
    stderrStream.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });
    child.on("error", (error) => {
      fail(withSnippet(`exec failed: ${firstLine(error.message)}`, stderr));
    });
    // The probe owns everything the command started. When the command
    // exits, what it left in the background goes with it, whether or not it
    // still holds a pipe. The group id is the command's own pid, which the
    // system has only just released.
    //
    // close comes once the pipes are drained, which is the normal end. exit
    // comes first, and after it the output gets a moment to arrive. A
    // grandchild that left the group can still hold a pipe past that moment.
    child.on("exit", (code, signal) => {
      killChild(child);
      drain = setTimeout(() => finish(code, signal), EXIT_DRAIN_MS);
    });
    child.on("close", (code, signal) => finish(code, signal));
    stdin.on("error", () => {
      // The process closed stdin early. close reports the exit status.
    });
    stdin.end(`${probeMessage(input)}\n`);
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
      body: probeMessage(input),
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

// The message is put together as text. A structured probe carries the call
// as the text the scenario wrote, so the other process is given exactly what
// the scenario says it sends, and printing 10000 levels of nesting does not
// need the stack here.
function probeMessage(input: AdapterRunInput): string {
  const base = JSON.stringify({
    raw: input.raw,
    sandboxDir: input.sandboxDir,
    aborted: input.aborted,
  });
  if (input.call === undefined) return base;
  const split = splitCall(input.raw);
  if (!split) return base;
  return `${base.slice(0, -1)},"call":{"name":${split.nameJson},"arguments":${split.argumentsJson}}}`;
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
