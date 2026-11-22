import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export type Jailed = { ok: true; path: string } | { ok: false; reason: string };

// Characters that change how a path reads without changing how it looks:
// zero-width and joiner characters, bidi marks, embeddings, overrides and
// isolates, invisible operators, and the soft hyphen.
const INVISIBLE = new Set([
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a,
  0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
  0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e,
  0x206f, 0xfeff,
]);

export function resolveInside(workspace: string, userPath: string): Jailed {
  if (userPath.length === 0) return refuse("empty path");
  const odd = oddCharacter(userPath);
  if (odd !== undefined) return refuse(odd);
  if (path.isAbsolute(userPath) || path.win32.isAbsolute(userPath)) {
    return refuse("absolute path rejected");
  }
  if (userPath.split(/[\\/]/).includes("..")) {
    return refuse("parent segment rejected");
  }
  const resolved = path.resolve(workspace, userPath);
  if (isOutside(workspace, resolved)) return refuse("path escapes workspace");
  // The lexical check passed. Now follow the links. Start at the deepest part
  // of the path that is on disk. lstat sees a symlink whose target is missing,
  // so a dangling link is found here and not created through.
  let anchor = resolved;
  while (!onDisk(anchor)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) return refuse("path escapes workspace");
    anchor = parent;
  }
  let realAnchor: string;
  try {
    realAnchor = realpathSync(anchor);
  } catch {
    return refuse("dangling symlink rejected");
  }
  if (isOutside(realpathSync(workspace), realAnchor)) {
    return refuse("symlink escapes workspace");
  }
  return { ok: true, path: resolved };
}

function oddCharacter(value: string): string | undefined {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code < 0x20 || code === 0x7f) return "path contains control characters";
    if (INVISIBLE.has(code)) return "path contains invisible characters";
  }
  return undefined;
}

function onDisk(target: string): boolean {
  return lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative)) return true;
  return relative === ".." || relative.startsWith(`..${path.sep}`);
}

function refuse(reason: string): Jailed {
  return { ok: false, reason };
}
