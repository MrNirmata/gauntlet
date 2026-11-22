import type { RunOutput, ToolCall } from "./types.ts";

// The one place that decides whether a value is a RunOutput. In-process
// adapters, --exec, and --http all pass through it.
export function asRunOutput(value: unknown): RunOutput | undefined {
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
  if (!isJsonValue(args)) return undefined;
  // fromEntries defines own properties. Assigning a key named __proto__
  // would set the prototype of the copy instead.
  return {
    name: value.name,
    arguments: Object.fromEntries(Object.entries(args)),
  };
}

// Arguments are data. A module adapter can hand back a BigInt, a function,
// NaN, or an object that contains itself, and a report cannot print those. The
// walk uses a list, so arguments 10000 levels deep do not use the stack, and
// it stops at a budget, so a value that contains itself ends.
const MAX_ARGUMENT_NODES = 200_000;

function isJsonValue(root: unknown): boolean {
  const pending: unknown[] = [root];
  let seen = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    seen += 1;
    if (seen > MAX_ARGUMENT_NODES) return false;
    // JSON.stringify drops an undefined property, so it prints.
    if (value === null || value === undefined) continue;
    const kind = typeof value;
    if (kind === "string" || kind === "boolean") continue;
    // JSON has no NaN and no Infinity. A report would print them as null.
    if (kind === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (kind !== "object") return false;
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    for (const entry of Object.values(value as object)) pending.push(entry);
  }
  return true;
}
