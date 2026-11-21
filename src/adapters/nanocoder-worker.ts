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

type Job = { raw: string; sandboxDir: string };

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
process.stdout.write(`${JSON.stringify(output)}\n`);

function runJob(
  input: Job,
  parseToolCalls: ParseToolCalls,
  resolveFilePath: ResolveFilePath,
): RunOutput {
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
  writeFileSync(resolved, args.content, "utf8");
  return { status: "executed", call: toolCall, result: "wrote" };
}
