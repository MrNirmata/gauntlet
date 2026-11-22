import type { ToolCall } from "./types.ts";

export type SplitCall = {
  // The call as an object, for an adapter in this process.
  readonly call: ToolCall;
  // The same two parts as the text the scenario wrote. A message to another
  // process is put together from these, so a key named __proto__, an escaped
  // lone surrogate, and 10000 levels of nesting arrive as they were written.
  readonly nameJson: string;
  readonly argumentsJson: string;
};

const CALL_SHAPE = /^\{"name":("(?:[^"\\]|\\.)*"),"arguments":([\s\S]*)\}$/;

// An execute scenario writes its payload as {"name":…,"arguments":{…}}.
// Returns undefined for any other text.
export function splitCall(raw: string): SplitCall | undefined {
  const match = CALL_SHAPE.exec(raw);
  const nameJson = match?.[1];
  const argumentsJson = match?.[2];
  if (nameJson === undefined || argumentsJson === undefined) return undefined;
  let name: unknown;
  let args: unknown;
  try {
    name = JSON.parse(nameJson);
    // JSON.parse defines __proto__ as an own key and does not recurse.
    args = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  if (typeof name !== "string") return undefined;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  return {
    call: { name, arguments: args as Record<string, unknown> },
    nameJson,
    argumentsJson,
  };
}
