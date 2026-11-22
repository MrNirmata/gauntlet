// Loads Nano-Collective/nanocoder at the pinned checkout and runs one payload.
// Calls parseToolCalls from source/tool-calling/tool-parser.ts, the same
// function turn-engine.ts uses for text tool calls, and resolveFilePath from
// source/utils/fs/path-validation.ts, the jail read_file and write_file use.
// The read and write of the resolved path are Node fs. turn-engine.ts is not
// called, so an aborted stream is not visible here.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RunOutput } from "../types.ts";

type ToolSchemas = Record<
  string,
  { type: string; properties: Record<string, { type: string }> }
>;

type ParsedCall = {
  function: { name: string; arguments: Record<string, unknown> };
};

type ParseResult =
  | { success: true; toolCalls: ParsedCall[] }
  | { success: false; error: string };

type ParseToolCalls = (
  content: unknown,
  toolNames?: readonly string[],
  toolSchemas?: ToolSchemas,
) => ParseResult;

type ResolveFilePath = (
  filePath: string,
  cwd: string,
  containmentRoot?: string,
) => string;

// inputSchema on read_file (source/tools/read-file.tsx) and write_file
// (source/tools/file-ops/write-file.tsx). getToolSchemas passes these through.
// A property typed string is not trimmed by XMLToolCallParser.parseParameters.
const SCHEMAS: ToolSchemas = {
  read_file: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
  },
  write_file: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  },
};

const OFFERED = ["read_file", "write_file"] as const;

type Job = { raw: string; sandboxDir: string; aborted: boolean };

const SIZE_LIMIT = 65536;

const checkout = process.argv[2];
if (checkout === undefined || checkout.length === 0) {
  throw new Error("missing nanocoder checkout");
}

const job = JSON.parse(readFileSync(0, "utf8")) as Job;
const parserHref = pathToFileURL(
  path.join(checkout, "source/tool-calling/tool-parser.ts"),
).href;
const pathHref = pathToFileURL(
  path.join(checkout, "source/utils/fs/path-validation.ts"),
).href;
const parserModule = (await import(parserHref)) as {
  parseToolCalls: ParseToolCalls;
};
const pathModule = (await import(pathHref)) as {
  resolveFilePath: ResolveFilePath;
};

const output = runJob(
  job,
  parserModule.parseToolCalls,
  pathModule.resolveFilePath,
);
process.stdout.write(`${replyText(output)}\n`);

function runJob(
  input: Job,
  parseToolCalls: ParseToolCalls,
  resolveFilePath: ResolveFilePath,
): RunOutput {
  // turn-engine.ts returns before executeTools when signal.aborted.
  // This shim does not call that function.
  if (input.aborted) {
    return {
      status: "not-covered",
      reason: "abort check is in turn-engine.ts, which this shim does not call",
    };
  }
  const parsed = parseToolCalls(input.raw, OFFERED, SCHEMAS);
  if (!parsed.success) return { status: "refused", reason: parsed.error };
  const call = parsed.toolCalls[0];
  if (call === undefined) return { status: "refused", reason: "no tool call" };
  if (parsed.toolCalls.length !== 1) {
    return { status: "refused", reason: "parsed more than one tool call" };
  }
  return execute(call, input.sandboxDir, resolveFilePath);
}

function execute(
  call: ParsedCall,
  sandboxDir: string,
  resolveFilePath: ResolveFilePath,
): RunOutput {
  const name = call.function.name;
  const args = call.function.arguments;
  if (name !== "read_file" && name !== "write_file") {
    return { status: "refused", reason: `unknown tool ${name}` };
  }
  const userPath = args.path;
  if (typeof userPath !== "string") {
    return { status: "refused", reason: "missing path" };
  }
  let resolved: string;
  try {
    resolved = resolveFilePath(userPath, sandboxDir, sandboxDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "refused", reason: message };
  }
  const toolCall = { name, arguments: args };
  if (name === "read_file") {
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return { status: "executed", call: toolCall, result: "error: not found" };
    }
    return {
      status: "executed",
      call: toolCall,
      result: readFileSync(resolved, "utf8"),
    };
  }
  if (typeof args.content !== "string") {
    return { status: "refused", reason: "content was not a string" };
  }
  // executeWriteFile and the mutation firewall are not called, so a size cap
  // there is not measured.
  if (Buffer.byteLength(args.content) > SIZE_LIMIT) {
    return {
      status: "not-covered",
      reason:
        "size check is in executeWriteFile, which this shim does not call",
    };
  }
  // How the bytes reach the disk is also executeWriteFile's decision: what it
  // does with text UTF-8 cannot hold, and whether it writes in place or
  // replaces the file. A plain writeFileSync here would measure Node.
  if (/\p{Cs}/u.test(args.content) || hasSecondLink(resolved)) {
    return {
      status: "not-covered",
      reason: "the write is in executeWriteFile, which this shim does not call",
    };
  }
  try {
    writeFileSync(resolved, args.content, "utf8");
  } catch (error) {
    return {
      status: "executed",
      call: toolCall,
      result: `error: ${errorCode(error)}`,
    };
  }
  return { status: "executed", call: toolCall, result: "wrote" };
}

function hasSecondLink(file: string): boolean {
  try {
    const stat = statSync(file, { throwIfNoEntry: false });
    return stat !== undefined && stat.nlink > 1;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "failed";
}

// An executed output carries the call back. JSON.stringify recurses, and the
// arguments of deep-nesting are deeper than its stack on Node 22 and 24. The
// scenario asks what nanocoder does with the call, not whether this shim
// can print it, so the arguments are left out when they cannot be printed.
function replyText(reply: RunOutput): string {
  try {
    return JSON.stringify(reply);
  } catch (error) {
    if (!(error instanceof RangeError) || reply.status !== "executed") {
      throw error;
    }
    return JSON.stringify({
      ...reply,
      call: { name: reply.call.name, arguments: {} },
    });
  }
}
