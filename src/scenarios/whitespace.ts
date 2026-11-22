import { existsSync, readFileSync } from "node:fs";
import { FIXTURE_NOTE } from "../sandbox.ts";
import type { Scenario } from "../types.ts";
import {
  call,
  fail,
  outsideIntact,
  pass,
  readNote,
  sole,
  workspaceFile,
  wroteExtra,
} from "./checks.ts";

const WHITESPACE_PAYLOAD = `<read_file>
<path> notes.txt </path>
<encoding> utf-8 </encoding>
</read_file>`;

// Indentation, a tab, a space before the newline, and the last newline. All
// of it is content.
const PADDED_CONTENT = "  indented\n\ttab \n";

export const whitespaceScenarios: readonly Scenario[] = [
  {
    id: "whitespace-padded-args",
    title: "Padded path and enum",
    category: "whitespace",
    summary:
      "Nano-Collective/nanocoder issue 2305 stopped trimming padded path and enum strings.",
    expected: "Trims the path and the encoding, then reads notes.txt.",
    aborted: false,
    probes: [() => WHITESPACE_PAYLOAD],
    expect({ outputs }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (output.status !== "executed")
        return fail("refused a padded but valid call");
      const pathArg = output.call.arguments.path;
      const encoding = output.call.arguments.encoding;
      if (pathArg !== "notes.txt" || encoding !== "utf-8") {
        return fail("path or encoding kept surrounding whitespace");
      }
      if (output.call.name !== "read_file" || output.result !== FIXTURE_NOTE) {
        return fail("read did not return notes.txt");
      }
      return pass("trimmed path and encoding, read notes.txt");
    },
  },
  {
    id: "content-whitespace-kept",
    title: "Whitespace that belongs to the content",
    category: "whitespace",
    summary:
      "write_file content starts with two spaces and ends with a space and a newline. Trimming every argument to fix a padded path damages the file.",
    expected: "Writes padded.txt with the content byte for byte.",
    aborted: false,
    probes: [
      () => call("write_file", { path: "padded.txt", content: PADDED_CONTENT }),
    ],
    expect({ outputs, sandbox }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (
        readNote(sandbox) !== FIXTURE_NOTE ||
        wroteExtra(sandbox, ["notes.txt", "padded.txt"]) ||
        !outsideIntact(sandbox)
      ) {
        return existsSync(workspaceFile(sandbox, "padded.txt"))
          ? fail("wrote a file other than padded.txt")
          : fail("did not write padded.txt");
      }
      if (output.status !== "executed") return fail("refused a valid write");
      const written = readFileSync(
        workspaceFile(sandbox, "padded.txt"),
        "utf8",
      );
      if (
        written !== PADDED_CONTENT ||
        output.call.arguments.content !== PADDED_CONTENT
      ) {
        return fail("trimmed whitespace that belongs to the content");
      }
      return pass("wrote the content with its whitespace");
    },
  },
];
