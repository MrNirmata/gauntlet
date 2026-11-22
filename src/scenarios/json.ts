import { existsSync } from "node:fs";
import { FIXTURE_NOTE } from "../sandbox.ts";
import type { Scenario } from "../types.ts";
import {
  fail,
  pass,
  readNote,
  refusedAfterWrite,
  sole,
  workspaceFile,
} from "./checks.ts";

const TRUNCATED_PAYLOAD = '{"name":"read_file","arguments":{"path":"notes.txt"';

const TRAILING_COMMA_PAYLOAD =
  '{"name":"read_file","arguments":{"path":"notes.txt",}}';

const TRAILING_COMMA_IN_STRING_CONTENT = "x = [1, 2,] y = {a: 1,}";

const TRAILING_COMMA_IN_STRING_PAYLOAD =
  '{"name":"write_file","arguments":{"path":"notes.txt","content":"x = [1, 2,] y = {a: 1,}",}}';

const DUPLICATE_KEY_PAYLOAD =
  '{"name":"write_file","arguments":{"path":"notes.txt","path":"stolen.txt","content":"x","content":"stolen"}}';

const DUPLICATE_PATH_PAYLOAD =
  '{"name":"write_file","arguments":{"path":"notes.txt","path":"stolen.txt","content":"x"}}';

const ESCAPED_ARGUMENTS_PAYLOAD =
  '{"name":"write_file","\\u0061rguments":{"path":"notes.txt","path":"stolen.txt","content":"x"}}';

const DECOY_ARGUMENTS_PAYLOAD =
  '{"name":"write_file","note":"arguments","x":{"a":1},"arguments":{"path":"notes.txt","path":"stolen.txt","content":"x"}}';

const DUPLICATE_ARGUMENTS_PAYLOAD = repeatedArguments(
  JSON.stringify({ path: "notes.txt", content: "x" }),
  JSON.stringify({ path: "stolen.txt", content: "stolen" }),
);

const DUPLICATE_STRING_ARGUMENTS_PAYLOAD = repeatedArguments(
  JSON.stringify(JSON.stringify({ path: "notes.txt", content: "x" })),
  JSON.stringify(JSON.stringify({ path: "stolen.txt", content: "stolen" })),
);

const ESCAPED_PATH_PAYLOAD =
  '{"name":"write_file","arguments":{"path":"notes.txt","\\u0070ath":"stolen.txt","content":"x"}}';

const NESTED_DUPLICATE_PAYLOAD =
  '{"name":"write_file","arguments":{"path":"notes.txt","content":"x","tags":[{"a":1,"a":2}]}}';

const TRAILING_COMMA_DUPLICATE_PAYLOAD =
  '{"name":"write_file","meta":{"a":1,},"arguments":{"path":"notes.txt","path":"stolen.txt","content":"x"}}';

const SCALAR_DUPLICATE_PAYLOAD =
  '{"name":"write_file","arguments":{"ok":true,"n":-2.5e+1,"z":null,"f":false,"path":"notes.txt","path":"stolen.txt","content":"x"}}';

// Not JSON, and not a trailing comma either. A scan that gives up on the lone
// comma reports no duplicate, and a repair that deletes it makes the text
// parse.
const LONE_COMMA_OBJECT_PAYLOAD =
  '{"name":"write_file","x":{,},"arguments":{"path":"notes.txt","path":"stolen.txt","content":"x"}}';

const LONE_COMMA_ARRAY_PAYLOAD =
  '{"name":"write_file","x":[,],"arguments":{"path":"notes.txt","path":"stolen.txt","content":"x"}}';

const DOUBLE_COMMA_PAYLOAD =
  '{"name":"write_file","x":[1,,],"arguments":{"path":"notes.txt","path":"stolen.txt","content":"x"}}';

const STRING_ARGUMENTS_PAYLOAD = JSON.stringify({
  name: "read_file",
  arguments: JSON.stringify({ path: "notes.txt" }),
});

const PROTO_KEY_PAYLOAD =
  '{"name":"write_file","arguments":{"__proto__":{"path":"pwned.txt","content":"pwned"}}}';

const ARRAY_PATH_PAYLOAD =
  '{"name":"write_file","arguments":{"path":["notes.txt"],"content":"x"}}';

const OBJECT_CONTENT_PAYLOAD =
  '{"name":"write_file","arguments":{"path":"notes.txt","content":{"a":1}}}';

const NUMBER_PATH_PAYLOAD =
  '{"name":"write_file","arguments":{"path":7,"content":"x"}}';

export const jsonScenarios: readonly Scenario[] = [
  {
    id: "truncated-json",
    title: "Truncated JSON arguments",
    category: "json",
    summary:
      "JSON cut off after a path value, before the arguments object closes.",
    expected: "Refuses the call.",
    aborted: false,
    probes: [() => TRUNCATED_PAYLOAD],
    expect({ outputs, sandbox }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (output.status !== "refused")
        return fail("executed a truncated tool call");
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused truncated JSON");
    },
  },
  {
    id: "trailing-comma-json",
    title: "Trailing comma in JSON arguments",
    category: "json",
    summary:
      "A trailing comma sits before the closing brace of the arguments object.",
    expected: "Repairs the comma and reads notes.txt.",
    aborted: false,
    probes: [() => TRAILING_COMMA_PAYLOAD],
    expect({ outputs }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (output.status !== "executed")
        return fail("rejected JSON with a trailing comma");
      if (
        output.call.arguments.path !== "notes.txt" ||
        output.result !== FIXTURE_NOTE
      ) {
        return fail("trailing comma parsed to the wrong call");
      }
      return pass("parsed trailing comma and read notes.txt");
    },
  },
  {
    id: "trailing-comma-in-string",
    title: "Trailing comma inside a JSON string",
    category: "json",
    summary:
      "A structural trailing comma, and string content that contains ,] and ,}.",
    expected:
      "Refuses the call, or writes the string to notes.txt byte for byte.",
    aborted: false,
    probes: [() => TRAILING_COMMA_IN_STRING_PAYLOAD],
    expect({ outputs, sandbox }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (output.status === "refused") {
        const written = refusedAfterWrite(sandbox, ["notes.txt"]);
        if (written) return written;
        return pass("refused the trailing comma call");
      }
      if (output.status !== "executed") {
        return fail("trailing-comma repair rewrote string content");
      }
      const note = readNote(sandbox);
      if (
        output.call.name === "write_file" &&
        output.call.arguments.path === "notes.txt" &&
        output.call.arguments.content === TRAILING_COMMA_IN_STRING_CONTENT &&
        note === TRAILING_COMMA_IN_STRING_CONTENT
      ) {
        return pass("wrote the original string bytes to notes.txt");
      }
      return fail("trailing-comma repair rewrote string content");
    },
  },
  {
    id: "duplicate-keys",
    title: "Duplicate JSON keys",
    category: "json",
    summary:
      "Duplicate keys at any depth. The last value is the one that writes stolen.txt.",
    expected: "Refuses every call and does not write stolen.txt.",
    aborted: false,
    probes: [
      () => DUPLICATE_KEY_PAYLOAD,
      () => DUPLICATE_PATH_PAYLOAD,
      () => ESCAPED_ARGUMENTS_PAYLOAD,
      () => DECOY_ARGUMENTS_PAYLOAD,
      () => DUPLICATE_ARGUMENTS_PAYLOAD,
      () => DUPLICATE_STRING_ARGUMENTS_PAYLOAD,
      () => ESCAPED_PATH_PAYLOAD,
      () => NESTED_DUPLICATE_PAYLOAD,
      () => TRAILING_COMMA_DUPLICATE_PAYLOAD,
      () => SCALAR_DUPLICATE_PAYLOAD,
    ],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      if (existsSync(workspaceFile(sandbox, "stolen.txt"))) {
        return fail("duplicate key last-wins wrote stolen.txt");
      }
      if (readNote(sandbox) !== FIXTURE_NOTE)
        return fail("duplicate key last-wins wrote stolen.txt");
      for (const output of outputs) {
        if (output.status !== "refused") return fail("accepted duplicate keys");
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused duplicate keys");
    },
  },
  {
    id: "duplicate-keys-after-repair",
    title: "Duplicate keys behind a repaired syntax error",
    category: "json",
    summary:
      "A lone comma makes the text invalid. A repair that deletes it leaves duplicate keys the first check never saw.",
    expected: "Refuses every call and does not write stolen.txt.",
    aborted: false,
    probes: [
      () => LONE_COMMA_OBJECT_PAYLOAD,
      () => LONE_COMMA_ARRAY_PAYLOAD,
      () => DOUBLE_COMMA_PAYLOAD,
    ],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      if (
        existsSync(workspaceFile(sandbox, "stolen.txt")) ||
        readNote(sandbox) !== FIXTURE_NOTE
      ) {
        return fail("repair hid a duplicate key that wrote stolen.txt");
      }
      for (const output of outputs) {
        if (output.status !== "refused") {
          return fail("executed text that is not JSON");
        }
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused text that only a repair makes parse");
    },
  },
  {
    id: "json-string-arguments",
    title: "Double-encoded JSON arguments",
    category: "json",
    summary: "arguments arrives as a JSON string, not as an object.",
    expected: "Unwraps the string once and reads notes.txt.",
    aborted: false,
    probes: [() => STRING_ARGUMENTS_PAYLOAD],
    expect({ outputs }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (output.status !== "executed")
        return fail("refused arguments sent as a JSON string");
      if (
        output.call.name !== "read_file" ||
        output.call.arguments.path !== "notes.txt"
      ) {
        return fail("did not read path from the string arguments");
      }
      if (output.result !== FIXTURE_NOTE)
        return fail("read did not return notes.txt");
      return pass("unwrapped string arguments and read notes.txt");
    },
  },
  {
    id: "proto-key-arguments",
    title: "__proto__ as an argument key",
    category: "json",
    summary:
      "arguments holds one key, __proto__. Copying keys by assignment makes its value the prototype, and path and content are read from it.",
    expected: "Refuses the call. It has no path and no content of its own.",
    aborted: false,
    probes: [() => PROTO_KEY_PAYLOAD],
    expect({ outputs, sandbox }) {
      const output = sole(outputs);
      if (!output) return fail("no output");
      if (existsSync(workspaceFile(sandbox, "pwned.txt"))) {
        return fail("__proto__ supplied the path and wrote pwned.txt");
      }
      if (output.status !== "refused") {
        return fail("executed a call with no path of its own");
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused a call whose arguments were only __proto__");
    },
  },
  {
    id: "argument-type-confusion",
    title: "Arguments of the wrong type",
    category: "json",
    summary:
      "path is an array, then a number. content is an object. The tools take strings.",
    expected: "Refuses every call and writes nothing.",
    aborted: false,
    probes: [
      () => ARRAY_PATH_PAYLOAD,
      () => OBJECT_CONTENT_PAYLOAD,
      () => NUMBER_PATH_PAYLOAD,
    ],
    expect({ outputs, sandbox }) {
      if (outputs.length === 0) return fail("no output");
      if (readNote(sandbox) !== FIXTURE_NOTE) {
        return fail("coerced a non-string argument and wrote notes.txt");
      }
      if (existsSync(workspaceFile(sandbox, "7"))) {
        return fail("coerced a number to a path and wrote it");
      }
      for (const output of outputs) {
        if (output.status !== "refused") {
          return fail("accepted an argument that is not a string");
        }
      }
      const written = refusedAfterWrite(sandbox, ["notes.txt"]);
      if (written) return written;
      return pass("refused arguments that are not strings");
    },
  },
];

function repeatedArguments(first: string, second: string): string {
  return `{"name":"write_file","arguments":${first},"arguments":${second}}`;
}
