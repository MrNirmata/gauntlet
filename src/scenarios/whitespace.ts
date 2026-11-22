import { FIXTURE_NOTE } from "../sandbox.ts";
import type { Scenario } from "../types.ts";
import { fail, pass, sole } from "./checks.ts";

const WHITESPACE_PAYLOAD = `<read_file>
<path> notes.txt </path>
<encoding> utf-8 </encoding>
</read_file>`;

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
];
