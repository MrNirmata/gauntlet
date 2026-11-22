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
  // fromEntries defines own properties. Assigning a key named __proto__
  // would set the prototype of the copy instead.
  return {
    name: value.name,
    arguments: Object.fromEntries(Object.entries(args)),
  };
}
