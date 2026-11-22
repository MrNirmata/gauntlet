import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, RunOutput, ToolCall } from "../types.ts";
import { resolveInside } from "./reference/jail.ts";
import { parseStrictJson, setOwn } from "./reference/json.ts";
import { parseXmlCall } from "./reference/xml.ts";

const MAX_RAW_BYTES = 65536;
const MAX_JSON_DEPTH = 64;

// Each switch is one decision the two reference adapters make differently.
type Policy = {
  trimIdentifiers: boolean;
  // One parser that repairs a trailing comma and refuses duplicate keys and
  // deep nesting. Off means JSON.parse.
  strictJson: boolean;
  // Refuse an unclosed call, a repeated parameter, and stray text.
  strictXml: boolean;
  unwrapStringArguments: boolean;
  executeTruncatedJson: boolean;
  // Copy argument keys as own properties, and keep an argument's type.
  keepArgumentShape: boolean;
  // Look a tool up by its own name only. Off means `TOOLS[name]`, which
  // also finds constructor and toString.
  ownToolNamesOnly: boolean;
  jailPaths: boolean;
  // Refuse text UTF-8 cannot hold, and a write target that is not one plain
  // file with one name.
  guardWrites: boolean;
  honorAbort: boolean;
  executeToolCallFoundInResult: boolean;
  maxRawBytes: number | null;
};

type Parsed = { ok: true; call: ToolCall } | { ok: false; reason: string };

const naivePolicy: Policy = {
  trimIdentifiers: false,
  strictJson: false,
  strictXml: false,
  unwrapStringArguments: false,
  executeTruncatedJson: true,
  keepArgumentShape: false,
  ownToolNamesOnly: false,
  jailPaths: false,
  guardWrites: false,
  honorAbort: false,
  executeToolCallFoundInResult: true,
  maxRawBytes: null,
};

const hardenedPolicy: Policy = {
  trimIdentifiers: true,
  strictJson: true,
  strictXml: true,
  unwrapStringArguments: true,
  executeTruncatedJson: false,
  keepArgumentShape: true,
  ownToolNamesOnly: true,
  jailPaths: true,
  guardWrites: true,
  honorAbort: true,
  executeToolCallFoundInResult: false,
  maxRawBytes: MAX_RAW_BYTES,
};

export const referenceNaive: Adapter = {
  name: "reference-naive",
  run(input) {
    return Promise.resolve(
      executePayload(input.raw, input.sandboxDir, input.aborted, naivePolicy),
    );
  },
};

export const referenceHardened: Adapter = {
  name: "reference-hardened",
  run(input) {
    return Promise.resolve(
      executePayload(
        input.raw,
        input.sandboxDir,
        input.aborted,
        hardenedPolicy,
      ),
    );
  },
};

export const adapters: readonly Adapter[] = [referenceNaive, referenceHardened];

function executePayload(
  raw: string,
  sandboxDir: string,
  aborted: boolean,
  policy: Policy,
): RunOutput {
  if (policy.honorAbort && aborted) {
    return {
      status: "refused",
      reason: "stream aborted before the tool call finished",
    };
  }
  if (
    policy.maxRawBytes !== null &&
    Buffer.byteLength(raw) > policy.maxRawBytes
  ) {
    return {
      status: "refused",
      reason: `argument exceeds ${policy.maxRawBytes} bytes`,
    };
  }
  const parsed = raw.replace(LEADING_SPACE, "").startsWith("<")
    ? parseXmlCall(raw, { strict: policy.strictXml })
    : parseJson(raw, policy);
  if (!parsed.ok) return { status: "refused", reason: parsed.reason };
  const call = applyTrim(parsed.call, policy);
  const executed = executeCall(call, sandboxDir, policy);
  if (
    executed.status === "executed" &&
    policy.executeToolCallFoundInResult &&
    executed.call.name === "read_file"
  ) {
    const followUp = toolCallInText(executed.result);
    if (followUp) return executeCall(followUp, sandboxDir, policy);
  }
  return executed;
}

function applyTrim(call: ToolCall, policy: Policy): ToolCall {
  if (!policy.trimIdentifiers) return call;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.arguments)) {
    const identifier = key === "path" || key === "encoding" || key === "mode";
    setOwn(
      args,
      key,
      identifier && typeof value === "string" ? trimSpace(value) : value,
    );
  }
  return { name: call.name, arguments: args };
}

function parseJson(raw: string, policy: Policy): Parsed {
  if (policy.strictJson) {
    const parsed = parseStrict(raw);
    if (!parsed.ok) return parsed;
    return callFromValue(parsed.value, policy);
  }
  const direct = tryNativeCall(raw, policy);
  if (direct.ok) return direct;
  if (policy.executeTruncatedJson && !raw.trimEnd().endsWith("}")) {
    return parseTruncated(raw);
  }
  return { ok: false, reason: "invalid JSON" };
}

function parseStrict(
  text: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const parsed = parseStrictJson(text, {
    allowTrailingCommas: true,
    rejectDuplicateKeys: true,
    maxDepth: MAX_JSON_DEPTH,
  });
  if (parsed.ok) return parsed;
  return {
    ok: false,
    reason:
      parsed.reason === "invalid JSON"
        ? "truncated or invalid JSON"
        : parsed.reason,
  };
}

function tryNativeCall(raw: string, policy: Policy): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  return callFromValue(value, policy);
}

function parseTruncated(raw: string): Parsed {
  const name = /"name"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
  const pathValue = /"path"\s*:\s*"([^"]*)"/.exec(raw)?.[1];
  if (!name || pathValue === undefined)
    return { ok: false, reason: "truncated or invalid JSON" };
  const args: Record<string, unknown> = { path: pathValue };
  const content = /"content"\s*:\s*"([^"]*)"/.exec(raw)?.[1];
  if (content !== undefined) args.content = content;
  return { ok: true, call: { name, arguments: args } };
}

function callFromValue(value: unknown, policy: Policy): Parsed {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "truncated or invalid JSON" };
  }
  if (!Object.hasOwn(value, "name") || !Object.hasOwn(value, "arguments")) {
    return { ok: false, reason: "truncated or invalid JSON" };
  }
  const name = "name" in value ? value.name : undefined;
  const given = "arguments" in value ? value.arguments : undefined;
  let args = given;
  if (policy.unwrapStringArguments && typeof given === "string") {
    const inner = unwrapOnce(given);
    if (!inner.ok) return inner;
    args = inner.value;
  }
  if (
    typeof name !== "string" ||
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args)
  ) {
    return { ok: false, reason: "truncated or invalid JSON" };
  }
  const argumentsRecord: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(args)) {
    if (policy.keepArgumentShape) setOwn(argumentsRecord, key, entry);
    // Plain assignment. A key named __proto__ becomes the prototype.
    else argumentsRecord[key] = entry;
  }
  return { ok: true, call: { name, arguments: argumentsRecord } };
}

// Some providers send `arguments` as a JSON string. Decode it one level only,
// with the same parser, so a duplicate key inside the string is refused too.
// A string that decodes to another string stays a string and is refused.
function unwrapOnce(
  args: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const inner = parseStrict(args);
  if (inner.ok) return inner;
  if (inner.reason === "truncated or invalid JSON") {
    return { ok: true, value: args };
  }
  return inner;
}

function toolCallInText(text: string): ToolCall | null {
  const start = text.indexOf('{"name":');
  if (start < 0) return null;
  const slice = matchObject(text, start);
  if (!slice) return null;
  const parsed = tryNativeCall(slice, naivePolicy);
  return parsed.ok ? parsed.call : null;
}

function matchObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

type Tool = (target: string, content: string) => string;

const TOOLS: Record<string, Tool> = {
  read_file(target) {
    const stat = statSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile()) return "error: not found";
    return readFileSync(target, "utf8");
  },
  write_file(target, content) {
    writeFileSync(target, content, "utf8");
    return "wrote";
  },
};

function findTool(name: string, policy: Policy): Tool | undefined {
  if (policy.ownToolNamesOnly && !Object.hasOwn(TOOLS, name)) return undefined;
  const tool: unknown = TOOLS[name];
  return typeof tool === "function" ? (tool as Tool) : undefined;
}

function executeCall(
  call: ToolCall,
  sandboxDir: string,
  policy: Policy,
): RunOutput {
  const tool = findTool(call.name, policy);
  if (!tool) return { status: "refused", reason: "unknown tool" };
  const userPath = argumentText(call.arguments.path, policy);
  if (userPath === undefined) {
    return { status: "refused", reason: "missing argument" };
  }
  const content = argumentText(call.arguments.content, policy);
  if (call.name === "write_file" && content === undefined) {
    return { status: "refused", reason: "missing argument" };
  }
  const encoding = call.arguments.encoding;
  if (
    encoding !== undefined &&
    (typeof encoding !== "string" || !isUtf8(trimSpace(encoding)))
  ) {
    return { status: "refused", reason: "encoding not allowed" };
  }
  let resolved = path.resolve(sandboxDir, userPath);
  if (policy.jailPaths) {
    const jailed = resolveInside(sandboxDir, userPath);
    if (!jailed.ok) return { status: "refused", reason: jailed.reason };
    resolved = jailed.path;
  }
  if (policy.guardWrites && call.name === "write_file") {
    const reason = writeGuard(resolved, content ?? "");
    if (reason !== undefined) return { status: "refused", reason };
  }
  // A tool that fails hands the failure back as its result, the way an agent
  // loop reports a tool error to the model. The loop also turns whatever the
  // tool returned into text.
  try {
    return {
      status: "executed",
      call,
      result: String(tool(resolved, content ?? "")),
    };
  } catch (error) {
    return { status: "executed", call, result: `error: ${errorCode(error)}` };
  }
}

// A lone surrogate has no UTF-8 form. Node writes U+FFFD in its place, so the
// file would hold bytes the model did not send. Opening a FIFO for writing
// blocks until something reads it. A file with a second hard link may be the
// same file as one outside the workspace.
function writeGuard(target: string, content: string): string | undefined {
  if (/\p{Cs}/u.test(content)) return "content is not valid Unicode";
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(target, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
  if (stat === undefined) return undefined;
  if (!stat.isFile()) return "write target is not a regular file";
  if (stat.nlink > 1) return "write target has more than one hard link";
  return undefined;
}

// JavaScript trim() also removes U+FEFF, the no-break space, and the line
// separators. Trimming those turns a path the jail would refuse into one it
// accepts. Only the four JSON whitespace characters are padding.
const LEADING_SPACE = /^[ \t\r\n]+/;
const TRAILING_SPACE = /[ \t\r\n]+$/;

function trimSpace(value: string): string {
  return value.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
}

function isUtf8(encoding: string): boolean {
  const name = encoding.toLowerCase();
  return name === "utf-8" || name === "utf8";
}

// The tools take strings. Coercing anything else to a string turns
// ["notes.txt"] into a path and {} into file content.
function argumentText(value: unknown, policy: Policy): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null || policy.keepArgumentShape) {
    return undefined;
  }
  return String(value);
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
