import type { Classification } from "../types.ts";

const SAFETY = "safety";
const ROBUSTNESS = "robustness";
const PARSE = "parse";
const EXECUTE = "execute";

// Every scenario, classified in one place.
//
// tier says what a failure costs. safety is harm: a file outside the
// workspace, a call nobody sent, bytes the model did not write. robustness is
// a call that should have worked and did not, or a crash.
//
// layer says where the failure lives. A parse scenario sends text that is
// not a well-formed call. An execute scenario sends a well-formed call, so
// it can also be given to a target that never sees raw text.
//
// cwe names the weakness a failure points at. It is a classification made
// here, not one assigned by MITRE to any product.
export const CLASSIFICATION: Readonly<Record<string, Classification>> = {
  "whitespace-padded-args": { tier: ROBUSTNESS, layer: PARSE, cwe: [] },
  "content-whitespace-kept": { tier: ROBUSTNESS, layer: EXECUTE, cwe: [] },
  "truncated-json": { tier: SAFETY, layer: PARSE, cwe: ["CWE-20"] },
  "trailing-comma-json": { tier: ROBUSTNESS, layer: PARSE, cwe: [] },
  "trailing-comma-in-string": { tier: ROBUSTNESS, layer: PARSE, cwe: [] },
  "duplicate-keys": { tier: SAFETY, layer: PARSE, cwe: ["CWE-436"] },
  "duplicate-keys-after-repair": {
    tier: SAFETY,
    layer: PARSE,
    cwe: ["CWE-436"],
  },
  "json-string-arguments": { tier: ROBUSTNESS, layer: PARSE, cwe: [] },
  "proto-key-arguments": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-1321"] },
  "argument-type-confusion": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-20"] },
  "inherited-tool-name": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-470"] },
  "truncated-xml": { tier: SAFETY, layer: PARSE, cwe: ["CWE-20"] },
  "xml-duplicate-params": { tier: SAFETY, layer: PARSE, cwe: ["CWE-436"] },
  "unicode-zero-width-path": {
    tier: SAFETY,
    layer: EXECUTE,
    cwe: ["CWE-451"],
  },
  "unicode-bidi-path": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-451"] },
  "unicode-trimmed-path": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-180"] },
  "unicode-lone-surrogate": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-176"] },
  "path-escape": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-22"] },
  "path-escape-write": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-22"] },
  "path-symlink": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-59"] },
  "path-symlink-write": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-59"] },
  "path-nul-byte": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-158"] },
  "path-hardlink-write": { tier: SAFETY, layer: EXECUTE, cwe: ["CWE-62"] },
  "path-unusable": { tier: ROBUSTNESS, layer: EXECUTE, cwe: ["CWE-248"] },
  "stream-aborted": { tier: SAFETY, layer: EXECUTE, cwe: [] },
  "prompt-injection-result": {
    tier: SAFETY,
    layer: EXECUTE,
    cwe: ["CWE-1427"],
  },
  // The limit is on what the model sent. A file tool has no reason to turn
  // down a large file, so this is not a question for an executor.
  "oversized-argument": { tier: ROBUSTNESS, layer: PARSE, cwe: ["CWE-770"] },
  "deep-nesting": { tier: ROBUSTNESS, layer: EXECUTE, cwe: ["CWE-674"] },
};
