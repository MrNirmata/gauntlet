import { expect, test } from "vitest";
import { formatActionOutputs, formatMarkdownSummary } from "../src/summary.ts";

const report = {
  adapter: "reference-naive",
  gauntletVersion: "0.1.1",
  scenarios: [
    {
      id: "truncated-json",
      category: "json",
      status: "fail",
      reason: "executed a truncated tool call",
    },
    {
      id: "pipe|case",
      category: "json",
      status: "error",
      reason: "line one\nline|two",
    },
  ],
  totals: { pass: 1, fail: 1, error: 1, notCovered: 2 },
};

test("formatMarkdownSummary renders a table and escapes cells", () => {
  const text = formatMarkdownSummary(report);
  expect(text).toBe(`## Gauntlet

adapter: \`reference-naive\`
gauntlet: \`0.1.1\`

| scenario | category | status | reason |
| --- | --- | --- | --- |
| truncated-json | json | fail | executed a truncated tool call |
| pipe\\|case | json | error | line one line\\|two |

1 passed, 1 failed, 1 errors, 2 not covered
`);
  expect(text).not.toContain("### Baseline");
  expect(formatMarkdownSummary(JSON.stringify(report))).toBe(text);
});

test("formatMarkdownSummary adds a baseline section when the report has one", () => {
  const text = formatMarkdownSummary({
    ...report,
    baseline: {
      regressions: ["truncated-json"],
      improvements: ["trailing-comma-in-string"],
      new: ["future-case", "other"],
    },
  });
  expect(text).toContain("1 passed, 1 failed, 1 errors, 2 not covered\n\n");
  expect(text).toContain(`### Baseline

regressions:

- \`truncated-json\`

improvements:

- \`trailing-comma-in-string\`

new:

- \`future-case\`
- \`other\`

rerun with --update-baseline to record improvements
`);
});

test("an empty baseline section names each group", () => {
  const text = formatMarkdownSummary({
    ...report,
    baseline: { regressions: [], improvements: [], new: [] },
  });
  expect(text).toContain(`### Baseline

regressions: none

improvements: none

new: none
`);
  expect(text).not.toContain("--update-baseline");
});

test("formatActionOutputs maps totals and regressions", () => {
  expect(formatActionOutputs(report)).toBe(
    "pass=1\nfail=1\nerror=1\nnot-covered=2\nregressions=\n",
  );
  expect(
    formatActionOutputs({
      ...report,
      baseline: {
        regressions: ["truncated-json", "path-escape"],
        improvements: [],
        new: [],
      },
    }),
  ).toBe(
    "pass=1\nfail=1\nerror=1\nnot-covered=2\nregressions=truncated-json,path-escape\n",
  );
});

test("a report that is not the json schema throws", () => {
  expect(() => formatMarkdownSummary("")).toThrow("report was empty");
  expect(() => formatMarkdownSummary("{}")).toThrow("report missing adapter");
  expect(() => formatMarkdownSummary("{")).toThrow();
  expect(() => formatActionOutputs({})).toThrow("report missing adapter");
});
