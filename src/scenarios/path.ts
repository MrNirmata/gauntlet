import { existsSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { FIXTURE_NOTE, FIXTURE_SECRET } from "../sandbox.ts";
import type { Scenario } from "../types.ts";
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
} from "./checks.ts";

export const pathScenarios: readonly Scenario[] = [
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
      "write_file via ../outside.txt, via its absolute path, and via sub/../../created.txt.",
    expected:
      "Refuses every write. outside.txt keeps its bytes and no file appears beside the workspace.",
    aborted: false,
    probes: [
      () => call("write_file", { path: "../outside.txt", content: "x" }),
      (sandbox) =>
        call("write_file", { path: sandbox.outsideFile, content: "x" }),
      () => call("write_file", { path: "sub/../../created.txt", content: "x" }),
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
      "Refuses every write. outside.txt keeps its bytes and no file appears beside the workspace.",
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
      for (const output of outputs) {
        if (output.status !== "refused") {
          return fail("executed a write through a symlink");
        }
      }
      const written = refusedAfterWrite(sandbox, [
        "notes.txt",
        "alias",
        "fresh",
        "updir",
      ]);
      if (written) return written;
      return pass("rejected writes through symlinks");
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
];
