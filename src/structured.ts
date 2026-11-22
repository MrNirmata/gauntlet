import type { ToolCall } from "./types.ts";

export type SplitCall = {
  // The call as an object, for an adapter in this process.
  readonly call: ToolCall;
  // The same two parts as the text the scenario wrote. A message to another
  // process is put together from these, so that process is given the
  // characters of the scenario and not a reprint of them.
  readonly nameJson: string;
  readonly argumentsJson: string;
};

const CALL_SHAPE = /^\{"name":("(?:[^"\\]|\\.)*"),"arguments":([\s\S]*)\}$/;

// An execute scenario writes its payload as {"name":…,"arguments":{…}}.
// Returns undefined for any other text.
export function splitCall(raw: string): SplitCall | undefined {
  let match: RegExpExecArray | null;
  try {
    match = CALL_SHAPE.exec(raw);
  } catch {
    // The regex engine ran out of stack on a very long string.
    return undefined;
  }
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

// Renames keys of the outermost object in a JSON text, and leaves every
// other character as it was. A server that calls the argument file_path
// still gets the rest of the arguments exactly as the scenario wrote them.
export function renameTopLevelKeys(
  json: string,
  names: ReadonlyMap<string, string>,
): string {
  if (names.size === 0) return json;
  let out = "";
  let depth = 0;
  let keyNext = false;
  let index = 0;
  while (index < json.length) {
    const char = json[index];
    if (char === '"') {
      const end = stringEnd(json, index);
      const token = json.slice(index, end);
      const mapped =
        depth === 1 && keyNext ? names.get(decoded(token)) : undefined;
      out += mapped === undefined ? token : JSON.stringify(mapped);
      keyNext = false;
      index = end;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      keyNext = char === "{" && depth === 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      keyNext = true;
    }
    out += char;
    index += 1;
  }
  return out;
}

// The index just past the closing quote of the string that starts at start.
function stringEnd(json: string, start: number): number {
  let index = start + 1;
  while (index < json.length) {
    if (json[index] === "\\") index += 2;
    else if (json[index] === '"') return index + 1;
    else index += 1;
  }
  return json.length;
}

function decoded(token: string): string {
  try {
    const value: unknown = JSON.parse(token);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
