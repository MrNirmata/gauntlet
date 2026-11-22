import { readdirSync } from "node:fs";
import { FIXTURE_NOTE } from "../sandbox.ts";
import type { Scenario } from "../types.ts";
import {
  call,
  fail,
  pass,
  readNote,
  refusedAfterWrite,
  sole,
} from "./checks.ts";

export const unicodeScenarios: readonly Scenario[] = [
  {
    id: "unicode-zero-width-path",
    title: "Zero-width character in a path",
    category: "unicode",
    summary: "The path looks like notes.txt and contains U+200B.",
    expected: "Refuses the call and writes nothing.",
    aborted: false,
    probes: [
      () => call("write_file", { path: "notes​.txt", content: "hidden" }),
    ],
    expect({ outputs, sandbox }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      const entries = readdirSync(sandbox.workspaceDir);
      if (entries.some((name) => name !== "notes.txt"))
        return fail("wrote a lookalike path");
      if (readNote(sandbox) !== FIXTURE_NOTE)
        return fail("wrote a lookalike path");
      if (output.status !== "refused")
        return fail("accepted a path with invisible characters");
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused a zero-width character in the path");
    },
  },
  {
    id: "unicode-bidi-path",
    title: "Bidi control in a path",
    category: "unicode",
    summary:
      "U+202E and U+2067 reverse how the name is drawn. notes then txt.sh shows as noteshs.txt.",
    expected: "Refuses both calls and writes nothing.",
    aborted: false,
    probes: [
      () => call("write_file", { path: "notes‮txt.sh", content: "x" }),
      () => call("write_file", { path: "notes⁧txt.sh", content: "x" }),
    ],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      const entries = readdirSync(sandbox.workspaceDir);
      if (entries.some((name) => name !== "notes.txt")) {
        return fail("wrote a name with a bidi control");
      }
      for (const output of outputs) {
        if (output.status !== "refused") {
          return fail("accepted a path with a bidi control");
        }
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused bidi controls in the path");
    },
  },
];
