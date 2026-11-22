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

// The escape is in the payload as six characters. The surrogate exists only
// after the adapter parses the JSON.
const LONE_SURROGATE_PAYLOAD =
  '{"name":"write_file","arguments":{"path":"notes.txt","content":"A\\ud800B"}}';

export const unicodeScenarios: readonly Scenario[] = [
  {
    id: "unicode-zero-width-path",
    title: "Zero-width character in a path",
    category: "unicode",
    summary: "The path looks like notes.txt and contains U+200B.",
    expected: "Refuses the call and writes nothing.",
    aborted: false,
    probes: [
      () => call("write_file", { path: "notes\u200b.txt", content: "hidden" }),
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
      "U+202E draws what follows it right to left, so notes then txt.sh shows as noteshs.txt. U+2067 starts a right-to-left run.",
    expected: "Refuses both calls and writes nothing.",
    aborted: false,
    probes: [
      () => call("write_file", { path: "notes\u202etxt.sh", content: "x" }),
      () => call("write_file", { path: "notes\u2067txt.sh", content: "x" }),
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
  {
    id: "unicode-trimmed-path",
    title: "Invisible padding that a trim removes",
    category: "unicode",
    summary:
      "The path is notes.txt behind U+FEFF, then notes.txt before U+0085. JavaScript trim() removes the first and Python strip() removes the second, and the write lands on notes.txt.",
    expected: "Refuses both calls and writes nothing.",
    aborted: false,
    probes: [
      () => call("write_file", { path: "\ufeffnotes.txt", content: "x" }),
      () => call("write_file", { path: "notes.txt\u0085", content: "x" }),
    ],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      if (readNote(sandbox) !== FIXTURE_NOTE) {
        return fail("trimmed an invisible character and wrote notes.txt");
      }
      const entries = readdirSync(sandbox.workspaceDir);
      if (entries.some((name) => name !== "notes.txt")) {
        return fail("wrote a lookalike path");
      }
      for (const output of outputs) {
        if (output.status !== "refused") {
          return fail("accepted a path with invisible padding");
        }
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused invisible padding around the path");
    },
  },
  {
    id: "unicode-lone-surrogate",
    title: "Content that UTF-8 cannot hold",
    category: "unicode",
    summary:
      "write_file content has the escape \\ud800 with no second half. JSON allows it and UTF-8 has no bytes for it, so the file gets U+FFFD, or is emptied before the write fails.",
    expected: "Refuses the call and leaves notes.txt alone.",
    aborted: false,
    probes: [() => LONE_SURROGATE_PAYLOAD],
    expect({ outputs, sandbox }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (readNote(sandbox) !== FIXTURE_NOTE) {
        return fail("wrote bytes the model did not send");
      }
      if (output.status !== "refused") {
        return fail("accepted content that UTF-8 cannot hold");
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused content with a lone surrogate");
    },
  },
];
