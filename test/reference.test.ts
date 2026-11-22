import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { resolveInside } from "../src/adapters/reference/jail.ts";
import { parseStrictJson } from "../src/adapters/reference/json.ts";
import { parseXmlCall } from "../src/adapters/reference/xml.ts";
import { referenceHardened } from "../src/adapters/reference.ts";

const STRICT = {
  allowTrailingCommas: false,
  rejectDuplicateKeys: true,
  maxDepth: 64,
};
const LENIENT = { ...STRICT, allowTrailingCommas: true };

// mulberry32. The same seed gives the same documents on every run.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const KEY_PARTS = ["a", "b", "path", "__proto__", "é", "\n", '"', "\\", "😀"];

function randomValue(next: () => number, depth: number): unknown {
  const pick = Math.floor(next() * (depth > 3 ? 5 : 7));
  if (pick === 0) return null;
  if (pick === 1) return next() < 0.5;
  if (pick === 2) return Math.round((next() - 0.5) * 1e6) / 1e3;
  if (pick === 3) return Math.floor((next() - 0.5) * 1e12);
  if (pick === 4) {
    let text = "";
    const length = Math.floor(next() * 6);
    for (let index = 0; index < length; index += 1) {
      text += KEY_PARTS[Math.floor(next() * KEY_PARTS.length)] ?? "";
    }
    return text;
  }
  const length = Math.floor(next() * 4);
  if (pick === 5) {
    return Array.from({ length }, () => randomValue(next, depth + 1));
  }
  const entries: [string, unknown][] = [];
  for (let index = 0; index < length; index += 1) {
    const key = `${KEY_PARTS[Math.floor(next() * KEY_PARTS.length)]}${index}`;
    entries.push([key, randomValue(next, depth + 1)]);
  }
  return Object.fromEntries(entries);
}

test("the strict parser reads what JSON.parse reads", () => {
  const next = random(20261122);
  for (let round = 0; round < 500; round += 1) {
    const value = randomValue(next, 0);
    for (const text of [
      JSON.stringify(value),
      JSON.stringify(value, null, 2),
    ]) {
      const parsed = parseStrictJson(text, STRICT);
      expect(parsed, text).toEqual({ ok: true, value: JSON.parse(text) });
    }
  }
});

test("the strict parser refuses what JSON.parse refuses", () => {
  const invalid = [
    "",
    "{",
    '{"a":1',
    '{"a":1}}',
    '{"a":1} x',
    "{,}",
    "[,]",
    "[1,,2]",
    '{"a":1,,}',
    "{'a':1}",
    "{a:1}",
    '{"a":01}',
    '{"a":1.}',
    '{"a":.5}',
    '{"a":1e}',
    '{"a":+1}',
    '{"a":"\\x"}',
    '{"a":"\\u12"}',
    '{"a":"line\nbreak"}',
    '{"a":tru}',
    '{"a":nulll}',
    '{"a":NaN}',
    "// c\n{}",
  ];
  for (const text of invalid) {
    expect(() => JSON.parse(text), text).toThrow();
    expect(parseStrictJson(text, STRICT), text).toEqual({
      ok: false,
      reason: "invalid JSON",
    });
    if (text.includes(",}") || text.includes(",]")) continue;
    expect(parseStrictJson(text, LENIENT), text).toEqual({
      ok: false,
      reason: "invalid JSON",
    });
  }
});

test("a trailing comma is one comma after an item", () => {
  expect(parseStrictJson('{"a":[1,2,],}', LENIENT)).toEqual({
    ok: true,
    value: { a: [1, 2] },
  });
  expect(parseStrictJson('{"a":[1,2,],}', STRICT).ok).toBe(false);
  for (const text of ["{,}", "[,]", "[1,,]", '{"a":1,,}']) {
    expect(parseStrictJson(text, LENIENT), text).toEqual({
      ok: false,
      reason: "invalid JSON",
    });
  }
});

test("a duplicate key is refused at any depth, escaped or not", () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"x":[{"b":{"c":1,"c":2}}]}',
    '{"a":1,"a":2,}',
  ]) {
    expect(parseStrictJson(text, LENIENT), text).toEqual({
      ok: false,
      reason: "duplicate key",
    });
  }
  expect(
    parseStrictJson('{"a":1,"a":2}', { ...STRICT, rejectDuplicateKeys: false }),
  ).toEqual({ ok: true, value: { a: 2 } });
});

test("nesting stops at maxDepth without touching the stack limit", () => {
  const deep = (levels: number) => "[".repeat(levels) + "]".repeat(levels);
  expect(parseStrictJson(deep(64), STRICT).ok).toBe(true);
  expect(parseStrictJson(deep(65), STRICT)).toEqual({
    ok: false,
    reason: "nesting too deep",
  });
  expect(parseStrictJson(deep(200_000), STRICT)).toEqual({
    ok: false,
    reason: "nesting too deep",
  });
});

test("__proto__ is an own key and not a prototype", () => {
  const parsed = parseStrictJson('{"__proto__":{"path":"x"}}', STRICT);
  if (!parsed.ok) throw new Error("expected a parse");
  const value = parsed.value as Record<string, unknown>;
  expect(Object.keys(value)).toEqual(["__proto__"]);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(value.path).toBeUndefined();
});

test("strict XML refuses what the lenient parser accepts", () => {
  const strict = { strict: true };
  const lenient = { strict: false };
  const whole =
    "<write_file>\n<path>a.txt</path>\n<content>x</content>\n</write_file>";
  expect(parseXmlCall(whole, strict)).toEqual({
    ok: true,
    call: { name: "write_file", arguments: { path: "a.txt", content: "x" } },
  });
  expect(parseXmlCall(whole, lenient)).toEqual(parseXmlCall(whole, strict));
  const cases: [string, string][] = [
    [
      "<write_file>\n<path>a.txt</path>\n<content>x</content>\n",
      "truncated or invalid XML",
    ],
    [
      "<write_file>\n<path>a.txt</path>\n<content>x",
      "truncated or invalid XML",
    ],
    [
      "<write_file><path>a.txt</path><content>x</write_file>",
      "truncated or invalid XML",
    ],
    [
      "<write_file><path>a.txt</path><path>b.txt</path></write_file>",
      "duplicate parameter",
    ],
    [
      "<write_file><path>a.txt</path> stray <content>x</content></write_file>",
      "text between XML parameters",
    ],
    ["no tag", "invalid XML"],
  ];
  for (const [raw, reason] of cases) {
    expect(parseXmlCall(raw, strict), raw).toEqual({ ok: false, reason });
  }
  expect(
    parseXmlCall(
      "<write_file><path>a.txt</path><path>b.txt</path></write_file>",
      lenient,
    ),
  ).toMatchObject({ ok: true, call: { arguments: { path: "b.txt" } } });
  expect(
    parseXmlCall("<write_file>\n<path>a.txt</path>\n<content>x", lenient),
  ).toMatchObject({
    ok: true,
    call: { arguments: { path: "a.txt", content: "x" } },
  });
});

let root = "";
let workspace = "";

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "gauntlet-jail-"));
  workspace = path.join(root, "workspace");
  mkdirSync(path.join(workspace, "sub"), { recursive: true });
  writeFileSync(path.join(workspace, "notes.txt"), "hello\n");
  writeFileSync(path.join(root, "outside.txt"), "secret\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("the jail resolves paths that stay inside", () => {
  for (const inside of [
    "notes.txt",
    "new.txt",
    "sub/new.txt",
    "sub/deeper/new.txt",
    "./notes.txt",
  ]) {
    expect(resolveInside(workspace, inside), inside).toEqual({
      ok: true,
      path: path.resolve(workspace, inside),
    });
  }
  symlinkSync(path.join(workspace, "notes.txt"), path.join(workspace, "same"));
  expect(resolveInside(workspace, "same").ok).toBe(true);
});

test("the jail refuses every way out", () => {
  symlinkSync(path.join(root, "outside.txt"), path.join(workspace, "alias"));
  symlinkSync(path.join(root, "created.txt"), path.join(workspace, "fresh"));
  symlinkSync(root, path.join(workspace, "updir"));
  symlinkSync(path.join(root, "nowhere"), path.join(workspace, "gone"));
  symlinkSync("loop", path.join(workspace, "loop"));
  const cases: [string, string][] = [
    ["", "empty path"],
    ["../outside.txt", "parent segment rejected"],
    ["sub/../../outside.txt", "parent segment rejected"],
    ["sub\\..\\..\\outside.txt", "parent segment rejected"],
    [path.join(root, "outside.txt"), "absolute path rejected"],
    ["C:\\Windows\\win.ini", "absolute path rejected"],
    ["notes.txt\u0000.md", "path contains control characters"],
    ["notes\n.txt", "path contains control characters"],
    ["notes\u200b.txt", "path contains invisible characters"],
    ["notes\u202etxt.sh", "path contains invisible characters"],
    ["no\u00adtes.txt", "path contains invisible characters"],
    ["alias", "symlink escapes workspace"],
    ["fresh", "dangling symlink rejected"],
    ["updir/dropped.txt", "symlink escapes workspace"],
    ["gone/inner/file.txt", "dangling symlink rejected"],
    ["loop", "dangling symlink rejected"],
  ];
  for (const [userPath, reason] of cases) {
    expect(
      resolveInside(workspace, userPath),
      JSON.stringify(userPath),
    ).toEqual({
      ok: false,
      reason,
    });
  }
});

test("reference-hardened does not create a file through a dangling symlink", async () => {
  symlinkSync(path.join(root, "created.txt"), path.join(workspace, "fresh"));
  const output = await referenceHardened.run({
    raw: JSON.stringify({
      name: "write_file",
      arguments: { path: "fresh", content: "escaped" },
    }),
    sandboxDir: workspace,
    aborted: false,
  });
  expect(output).toEqual({
    status: "refused",
    reason: "dangling symlink rejected",
  });
  expect(readdirSync(root).sort()).toEqual(["outside.txt", "workspace"]);
});

test("reference-hardened reports a failed tool as its result", async () => {
  const output = await referenceHardened.run({
    raw: JSON.stringify({
      name: "write_file",
      arguments: { path: "sub", content: "x" },
    }),
    sandboxDir: workspace,
    aborted: false,
  });
  expect(output).toMatchObject({ status: "executed", result: "error: EISDIR" });
});
