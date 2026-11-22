import { existsSync, linkSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { FIXTURE_NOTE, FIXTURE_SECRET } from "../sandbox.ts";
import type { ScenarioCase } from "../types.ts";
import {
  call,
  containsSecret,
  fail,
  outsideIntact,
  pass,
  readNote,
  refusedAfterWrite,
  rootIntact,
  sole,
  workspaceFile,
  wroteExtra,
} from "./checks.ts";

const LONG_NAME_LENGTH = 300;

export const pathScenarios: readonly ScenarioCase[] = [
  {
    id: "path-escape",
    title: "Dotdot and absolute paths",
    category: "path",
    summary:
      "read_file via ../outside.txt and via the absolute path of that same file.",
    expected: "Refuses both reads and returns no byte of outside.txt.",
    aborted: false,
    probes: [
      () => call("read_file", { path: "../outside.txt" }),
      (sandbox) => call("read_file", { path: sandbox.outsideFile }),
    ],
    expect({ outputs, sandbox }) {
      const dotdot = outputs[0];
      const absolute = outputs[1];
      if (dotdot === undefined || absolute === undefined) {
        return fail("dotdot was executed");
      }
      if (containsSecret(dotdot)) {
        return fail("dotdot read a file outside the workspace");
      }
      if (containsSecret(absolute)) {
        return fail("absolute path read a file outside the workspace");
      }
      if (dotdot.status === "executed") return fail("dotdot was executed");
      if (absolute.status === "executed") {
        return fail("absolute path was executed");
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("rejected dotdot and absolute paths");
    },
  },
  {
    id: "path-escape-write",
    title: "Dotdot and absolute paths on write",
    category: "path",
    summary:
      "write_file via ../outside.txt, via its absolute path, via sub/../../created.txt, and via ../workspace.bak, whose path starts with the workspace's own.",
    expected:
      "Refuses every write. outside.txt keeps its bytes and no file appears beside the workspace.",
    aborted: false,
    probes: [
      () => call("write_file", { path: "../outside.txt", content: "x" }),
      (sandbox) =>
        call("write_file", { path: sandbox.outsideFile, content: "x" }),
      () => call("write_file", { path: "sub/../../created.txt", content: "x" }),
      // A jail that asks whether the resolved path starts with the workspace
      // path, with no separator after it, says yes to this one.
      () => call("write_file", { path: "../workspace.bak", content: "x" }),
    ],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      if (!outsideIntact(sandbox)) {
        return fail("overwrote a file outside the workspace");
      }
      if (!rootIntact(sandbox)) {
        return fail("created a file outside the workspace");
      }
      for (const output of outputs) {
        if (output.status !== "refused") {
          return fail("executed a write that leaves the workspace");
        }
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("rejected writes that leave the workspace");
    },
  },
  {
    id: "path-symlink",
    title: "Symlink out of the workspace",
    category: "path",
    summary:
      "alias is a symlink to a file that sits next to the workspace, not inside it.",
    expected: "Refuses the read and returns no byte of outside.txt.",
    setup: "alias is a symlink to outside.txt.",
    aborted: false,
    prepare(sandbox) {
      symlinkSync(sandbox.outsideFile, workspaceFile(sandbox, "alias"));
    },
    probes: [() => call("read_file", { path: "alias" })],
    expect({ outputs, sandbox }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (
        output.status === "executed" &&
        output.result.includes(FIXTURE_SECRET)
      ) {
        return fail("symlink read a file outside the workspace");
      }
      if (output.status !== "refused") return fail("symlink was executed");
      const written = refusedAfterWrite(sandbox, ["notes.txt", "alias"]);
      if (written) return written;
      return pass("rejected a symlink that leaves the workspace");
    },
  },
  {
    id: "path-symlink-write",
    title: "Write through a symlink",
    category: "path",
    summary:
      "write_file to a symlink to outside.txt, to a symlink whose target does not exist yet, and into a symlinked directory.",
    expected:
      "Refuses each write, or replaces the link with a new file inside. outside.txt keeps its bytes and no file appears beside the workspace.",
    setup:
      "alias links to outside.txt, fresh links to a missing created.txt beside the workspace, and updir links to the directory above the workspace.",
    aborted: false,
    prepare(sandbox) {
      symlinkSync(sandbox.outsideFile, workspaceFile(sandbox, "alias"));
      symlinkSync(
        path.join(sandbox.rootDir, "created.txt"),
        workspaceFile(sandbox, "fresh"),
      );
      symlinkSync(sandbox.rootDir, workspaceFile(sandbox, "updir"));
    },
    probes: [
      () => call("write_file", { path: "alias", content: "x" }),
      () => call("write_file", { path: "fresh", content: "x" }),
      () => call("write_file", { path: "updir/dropped.txt", content: "x" }),
    ],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      if (!outsideIntact(sandbox)) {
        return fail("symlink overwrote a file outside the workspace");
      }
      if (existsSync(path.join(sandbox.rootDir, "created.txt"))) {
        return fail("dangling symlink created a file outside the workspace");
      }
      if (existsSync(path.join(sandbox.rootDir, "dropped.txt"))) {
        return fail("symlinked directory wrote outside the workspace");
      }
      // What matters is above: nothing outside changed. An adapter may
      // refuse, or write a new file and rename it over the link.
      const names = ["notes.txt", "alias", "fresh", "updir"];
      if (outputs.every((output) => output.status === "refused")) {
        const written = refusedAfterWrite(sandbox, names);
        if (written) return written;
        return pass("rejected writes through symlinks");
      }
      if (readNote(sandbox) !== FIXTURE_NOTE || wroteExtra(sandbox, names)) {
        return fail("wrote a file the calls did not name");
      }
      return pass("left everything outside the workspace alone");
    },
  },
  {
    id: "path-nul-byte",
    title: "NUL byte in a path",
    category: "path",
    summary:
      "The path is notes.txt, a NUL byte, then .md. A C string ends at the NUL, so the write lands on notes.txt.",
    expected: "Refuses the call and writes nothing.",
    aborted: false,
    probes: [
      () => call("write_file", { path: "notes.txt\u0000.md", content: "x" }),
    ],
    expect({ outputs, sandbox }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (readNote(sandbox) !== FIXTURE_NOTE) {
        return fail("path was cut at the NUL byte and wrote notes.txt");
      }
      if (readdirSync(sandbox.workspaceDir).length !== 1) {
        return fail("wrote a path with a NUL byte");
      }
      if (output.status !== "refused") {
        return fail("passed a NUL byte to the filesystem");
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused a NUL byte in the path");
    },
  },
  {
    id: "path-hardlink-write",
    title: "Write to a hard link",
    category: "path",
    summary:
      "twin.txt and outside.txt are one file with two names. No path check can tell, and a write in place changes both.",
    expected:
      "Refuses the write, or replaces twin.txt with a new file. outside.txt keeps its bytes.",
    setup: "twin.txt is a hard link to outside.txt.",
    aborted: false,
    prepare(sandbox) {
      linkSync(sandbox.outsideFile, workspaceFile(sandbox, "twin.txt"));
    },
    probes: [() => call("write_file", { path: "twin.txt", content: "x" })],
    expect({ outputs, sandbox }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (!outsideIntact(sandbox)) {
        return fail("wrote through a hard link to a file outside");
      }
      if (output.status === "refused") {
        const written = refusedAfterWrite(sandbox, ["notes.txt", "twin.txt"]);
        if (written) return written;
        return pass("refused a write to a file with two names");
      }
      if (
        readNote(sandbox) !== FIXTURE_NOTE ||
        wroteExtra(sandbox, ["notes.txt", "twin.txt"])
      ) {
        return fail("wrote a file other than twin.txt");
      }
      return pass("replaced twin.txt and left outside.txt alone");
    },
  },
  {
    id: "path-unusable",
    title: "Paths the filesystem turns down",
    category: "path",
    summary:
      "read_file and write_file on notes.txt/x, then a read of a 300-character name. The filesystem answers with an error, and an adapter that lets it escape has crashed.",
    expected:
      "Refuses, or reports the failed tool as its result. Either way the adapter returns and writes nothing.",
    aborted: false,
    probes: [
      () => call("read_file", { path: "notes.txt/x" }),
      () => call("write_file", { path: "notes.txt/x", content: "x" }),
      () => call("read_file", { path: "a".repeat(LONG_NAME_LENGTH) }),
    ],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      for (const output of outputs) {
        if (output.status === "executed" && output.result === FIXTURE_NOTE) {
          return fail("read notes.txt through a path that goes past it");
        }
      }
      return pass("returned for paths the filesystem turns down");
    },
  },
];
