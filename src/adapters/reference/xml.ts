import type { ToolCall } from "../../types.ts";
import { setOwn } from "./json.ts";

export type XmlOptions = {
  // Refuse a call whose root tag never closes, a parameter that appears
  // twice, and text between parameters.
  strict: boolean;
};

export type XmlResult =
  | { ok: true; call: ToolCall }
  | { ok: false; reason: string };

const OPEN_TAG = /^<([a-z0-9_]+)>/;

// The fixture shape is a root tag whose child elements are the arguments.
export function parseXmlCall(raw: string, options: XmlOptions): XmlResult {
  const text = raw.trim();
  const name = OPEN_TAG.exec(text)?.[1];
  if (!name) return { ok: false, reason: "invalid XML" };
  const open = `<${name}>`;
  const close = `</${name}>`;
  const closed = text.endsWith(close);
  if (!closed && options.strict) {
    return { ok: false, reason: "truncated or invalid XML" };
  }
  const body = closed
    ? text.slice(open.length, text.length - close.length)
    : text.slice(open.length);
  return options.strict ? strictBody(name, body) : lenientBody(name, body);
}

function strictBody(name: string, body: string): XmlResult {
  const args: Record<string, unknown> = {};
  const seen = new Set<string>();
  let rest = body;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest.length === 0) return { ok: true, call: { name, arguments: args } };
    const key = OPEN_TAG.exec(rest)?.[1];
    if (!key) return { ok: false, reason: "text between XML parameters" };
    const end = rest.indexOf(`</${key}>`);
    if (end < 0) return { ok: false, reason: "truncated or invalid XML" };
    if (seen.has(key)) return { ok: false, reason: "duplicate parameter" };
    seen.add(key);
    setOwn(args, key, rest.slice(key.length + 2, end));
    rest = rest.slice(end + key.length + 3);
  }
}

// What a streaming parser does: take every parameter it can find, let a
// repeated one overwrite the first, and let an unclosed one run to the end.
function lenientBody(name: string, body: string): XmlResult {
  const args: Record<string, unknown> = {};
  let rest = body;
  for (;;) {
    const start = rest.search(/<[a-z0-9_]+>/);
    if (start < 0) break;
    rest = rest.slice(start);
    const key = OPEN_TAG.exec(rest)?.[1];
    if (!key) break;
    const end = rest.indexOf(`</${key}>`);
    if (end < 0) {
      args[key] = rest.slice(key.length + 2);
      break;
    }
    args[key] = rest.slice(key.length + 2, end);
    rest = rest.slice(end + key.length + 3);
  }
  return { ok: true, call: { name, arguments: args } };
}
