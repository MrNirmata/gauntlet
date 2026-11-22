import { existsSync } from "node:fs";
import { FIXTURE_NOTE } from "../sandbox.ts";
import type { ScenarioCase } from "../types.ts";
import {
  fail,
  pass,
  readNote,
  refusedAfterWrite,
  workspaceFile,
} from "./checks.ts";

const UNCLOSED_ROOT_PAYLOAD = `<write_file>
<path>notes.txt</path>
<content>partial</content>
`;

const UNCLOSED_PARAMETER_PAYLOAD = `<write_file>
<path>notes.txt</path>
<content>partial`;

const REPEATED_PATH_PAYLOAD = `<write_file>
<path>notes.txt</path>
<path>stolen.txt</path>
<content>x</content>
</write_file>`;

const INJECTED_PATH_PAYLOAD = `<write_file>
<path>notes.txt</path>
<content>x</content><path>stolen.txt</path><content>stolen</content>
</write_file>`;

export const xmlScenarios: readonly ScenarioCase[] = [
  {
    id: "truncated-xml",
    title: "Truncated XML tool call",
    category: "xml",
    summary:
      "The stream ends before the root tag closes, once after a full parameter and once inside one.",
    expected: "Refuses both calls and leaves notes.txt alone.",
    aborted: false,
    probes: [() => UNCLOSED_ROOT_PAYLOAD, () => UNCLOSED_PARAMETER_PAYLOAD],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      if (readNote(sandbox) !== FIXTURE_NOTE) {
        return fail("truncated call wrote notes.txt");
      }
      for (const output of outputs) {
        if (output.status !== "refused") {
          return fail("executed a truncated tool call");
        }
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused truncated XML");
    },
  },
  {
    id: "xml-duplicate-params",
    title: "Repeated XML parameter",
    category: "xml",
    summary:
      "path appears twice. The second one, once on its own line and once behind the content, is stolen.txt.",
    expected: "Refuses both calls and does not write stolen.txt.",
    aborted: false,
    probes: [() => REPEATED_PATH_PAYLOAD, () => INJECTED_PATH_PAYLOAD],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      if (existsSync(workspaceFile(sandbox, "stolen.txt"))) {
        return fail("repeated parameter last-wins wrote stolen.txt");
      }
      if (readNote(sandbox) !== FIXTURE_NOTE) {
        return fail("repeated parameter first-wins wrote notes.txt");
      }
      for (const output of outputs) {
        if (output.status !== "refused") {
          return fail("accepted a repeated parameter");
        }
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused a repeated parameter");
    },
  },
];
