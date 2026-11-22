// One parser decides both what the text means and whether it is acceptable.
// A separate duplicate-key scan in front of JSON.parse is two parsers, and any
// input they read differently is a way past the scan.

export type JsonOptions = {
  allowTrailingCommas: boolean;
  rejectDuplicateKeys: boolean;
  maxDepth: number;
};

export type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

class Refusal extends Error {}

export function parseStrictJson(
  text: string,
  options: JsonOptions,
): JsonResult {
  let index = 0;

  const invalid = (): never => {
    throw new Refusal("invalid JSON");
  };

  const skipSpace = (): void => {
    while (isSpace(text[index])) index += 1;
  };

  const readValue = (depth: number): unknown => {
    const char = text[index];
    if (char === "{") return readObject(depth);
    if (char === "[") return readArray(depth);
    if (char === '"') return readString();
    if (char === "-" || isDigit(char)) return readNumber();
    if (text.startsWith("true", index)) return readLiteral("true", true);
    if (text.startsWith("false", index)) return readLiteral("false", false);
    if (text.startsWith("null", index)) return readLiteral("null", null);
    return invalid();
  };

  const enter = (depth: number): number => {
    if (depth >= options.maxDepth) throw new Refusal("nesting too deep");
    return depth + 1;
  };

  // Returns true when the container closed.
  const afterItem = (close: "}" | "]"): boolean => {
    skipSpace();
    if (text[index] === ",") {
      index += 1;
      skipSpace();
      if (text[index] !== close) return false;
      if (!options.allowTrailingCommas) return invalid();
      index += 1;
      return true;
    }
    if (text[index] !== close) return invalid();
    index += 1;
    return true;
  };

  const readObject = (depth: number): Record<string, unknown> => {
    const inner = enter(depth);
    const record: Record<string, unknown> = {};
    const seen = new Set<string>();
    index += 1;
    skipSpace();
    if (text[index] === "}") {
      index += 1;
      return record;
    }
    for (;;) {
      if (text[index] !== '"') return invalid();
      const key = readString();
      if (seen.has(key)) {
        if (options.rejectDuplicateKeys) throw new Refusal("duplicate key");
      }
      seen.add(key);
      skipSpace();
      if (text[index] !== ":") return invalid();
      index += 1;
      skipSpace();
      setOwn(record, key, readValue(inner));
      if (afterItem("}")) return record;
    }
  };

  const readArray = (depth: number): unknown[] => {
    const inner = enter(depth);
    const items: unknown[] = [];
    index += 1;
    skipSpace();
    if (text[index] === "]") {
      index += 1;
      return items;
    }
    for (;;) {
      items.push(readValue(inner));
      if (afterItem("]")) return items;
    }
  };

  const readString = (): string => {
    let value = "";
    index += 1;
    for (;;) {
      const char = text[index];
      if (char === undefined) return invalid();
      if (char === '"') {
        index += 1;
        return value;
      }
      if (char < " ") return invalid();
      if (char !== "\\") {
        value += char;
        index += 1;
        continue;
      }
      const escaped = text[index + 1];
      if (escaped === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return invalid();
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      const mapped = escaped === undefined ? undefined : ESCAPES[escaped];
      if (mapped === undefined) return invalid();
      value += mapped;
      index += 2;
    }
  };

  const readNumber = (): number => {
    const start = index;
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
    } else if (isDigit(text[index])) {
      while (isDigit(text[index])) index += 1;
    } else {
      return invalid();
    }
    if (text[index] === ".") {
      index += 1;
      if (!isDigit(text[index])) return invalid();
      while (isDigit(text[index])) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!isDigit(text[index])) return invalid();
      while (isDigit(text[index])) index += 1;
    }
    return Number(text.slice(start, index));
  };

  const readLiteral = <T>(literal: string, value: T): T => {
    index += literal.length;
    return value;
  };

  try {
    skipSpace();
    const value = readValue(0);
    skipSpace();
    if (index !== text.length) return { ok: false, reason: "invalid JSON" };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

// `record[key] = value` runs the __proto__ setter on a plain object, which
// turns a key from the payload into the object's prototype. A defined
// property is an own property whatever the key is called.
export function setOwn(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}
