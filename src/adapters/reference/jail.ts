import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type Jailed = { ok: true; path: string } | { ok: false; reason: string };

// Characters that change how a path reads without changing how it looks, or
// that a terminal acts on. Every "other" category: controls, format
// characters such as zero-width and bidi marks, lone surrogates, private use,
// and unassigned. Every separator that is not the plain space.
const HIDDEN = /[\p{C}\p{Zl}\p{Zp}]|[^\P{Zs} ]/u;

// Letters and marks that draw as nothing: fillers, variation selectors, the
// combining grapheme joiner, the braille blank, the object replacement.
const BLANK: readonly (readonly [number, number])[] = [
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0],
  [0xfffc, 0xfffc],
  [0xe0100, 0xe01ef],
];

// The list errs toward refusing. A name with an emoji joiner or a Persian
// zero-width non-joiner is refused. A lookalike letter is not: a Cyrillic o
// is a letter, and no list of characters can tell which alphabet was meant.
//
// What this jail does not stop:
// - A symlink swapped between the check here and the open that follows. Node
//   cannot open a path beneath a directory in one step.
// - A read through a hard link to a file outside. That file is inside by
//   every test a path can pass.
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
  let realWorkspace: string;
  try {
    realAnchor = realpathSync(anchor);
  } catch {
    return refuse("dangling symlink rejected");
  }
  try {
    realWorkspace = realpathSync(workspace);
  } catch {
    return refuse("workspace not found");
  }
  if (isOutside(realWorkspace, realAnchor)) {
    return refuse("symlink escapes workspace");
  }
  // notes.txt/x: the part that is on disk is a file, and the rest of the path
  // would have to be inside it. On macOS such a path can name a resource fork.
  if (anchor !== resolved && !isDirectory(realAnchor)) {
    return refuse("path goes through a file");
  }
  return { ok: true, path: resolved };
}

function oddCharacter(value: string): string | undefined {
  let invisible = HIDDEN.test(value);
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return "path contains control characters";
    }
    if (BLANK.some(([first, last]) => code >= first && code <= last)) {
      invisible = true;
    }
  }
  return invisible ? "path contains invisible characters" : undefined;
}

// lstat reports more than a missing entry: a file used as a directory, a
// name too long, a link loop, no permission. None of those is on disk as far
// as this walk is concerned, and none of them may throw out of the adapter.
function onDisk(target: string): boolean {
  try {
    return lstatSync(target, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative)) return true;
  return relative === ".." || relative.startsWith(`..${path.sep}`);
}

function refuse(reason: string): Jailed {
  return { ok: false, reason };
}
