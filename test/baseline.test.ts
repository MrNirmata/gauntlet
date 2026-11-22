import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { formatJson, formatRun } from "../src/format.ts";
import { scenarios } from "../src/scenarios/index.ts";

const NAIVE_STATUS = {
  "argument-type-confusion": "fail",
  "content-whitespace-kept": "pass",
  "deep-nesting": "pass",
  "duplicate-keys": "fail",
  "duplicate-keys-after-repair": "pass",
  "inherited-tool-name": "fail",
  "json-string-arguments": "fail",
  "oversized-argument": "fail",
  "path-escape": "fail",
  "path-escape-write": "fail",
  "path-hardlink-write": "fail",
  "path-nul-byte": "fail",
  "path-symlink": "fail",
  "path-symlink-write": "fail",
  "path-unusable": "pass",
  "prompt-injection-result": "fail",
  "proto-key-arguments": "fail",
  "stream-aborted": "fail",
  "trailing-comma-in-string": "pass",
  "trailing-comma-json": "fail",
  "truncated-json": "fail",
  "truncated-xml": "fail",
  "unicode-bidi-path": "fail",
  "unicode-lone-surrogate": "fail",
  "unicode-trimmed-path": "fail",
  "unicode-zero-width-path": "fail",
  "whitespace-padded-args": "fail",
  "xml-duplicate-params": "fail",
} as const;

test("update-baseline writes the reference-naive results", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "baseline.json");
    const result = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--update-baseline",
      file,
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "5 passed, 23 failed, 0 errors, 0 not covered",
    );
    expect(Object.keys(NAIVE_STATUS).sort()).toEqual(
      scenarios.map((scenario) => scenario.id).sort(),
    );
    expect(readFileSync(file, "utf8")).toBe(expectedNaiveBaseline());
  });
});

test("the same run against that baseline exits 0", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "baseline.json");
    const recorded = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--update-baseline",
      file,
    ]);
    expect(recorded.code).toBe(0);
    const result = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--baseline",
      file,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const report = readReport(result.stdout);
    expect(Object.keys(report)).toEqual([
      "adapter",
      "gauntletVersion",
      "scenarios",
      "totals",
      "baseline",
    ]);
    expect(report.baseline).toEqual({
      regressions: [],
      improvements: [],
      new: [],
    });
    const one = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--scenario",
      "trailing-comma-in-string",
      "--baseline",
      file,
    ]);
    expect(one.code).toBe(0);
    expect(one.stderr).toBe("");
    expect(one.stdout).not.toContain("\nregressions:");
    expect(one.stdout).not.toContain("\nnew:");
  });
});

test("a baseline pass where the run fails exits 1", async () => {
  for (const previous of ["pass", "not-covered"] as const) {
    await withDir(async (dir) => {
      const file = path.join(dir, "baseline.json");
      writeFileSync(file, baselineFile({ "truncated-json": previous }));
      const result = await run([
        "run",
        "--adapter",
        "reference-naive",
        "--scenario",
        "truncated-json",
        "--baseline",
        file,
      ]);
      expect(result.code, previous).toBe(1);
      expect(result.stderr, previous).toBe("");
      expect(result.stdout, previous).toContain(
        "0 passed, 1 failed, 0 errors, 0 not covered\n\nregressions:\n  truncated-json\n",
      );
      expect(result.stdout, previous).not.toContain("\nimprovements:");
      expect(result.stdout, previous).not.toContain("\nnew:");
      expect(result.stdout, previous).not.toContain("--update-baseline");
    });
  }
  await withDir(async (dir) => {
    const file = path.join(dir, "baseline.json");
    writeFileSync(file, baselineFile({ "truncated-json": "pass" }));
    const result = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--scenario",
      "truncated-json",
      "--baseline",
      file,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const report = readReport(result.stdout);
    expect(report.scenarios[0]).toMatchObject({
      id: "truncated-json",
      status: "fail",
    });
    expect(report.baseline).toEqual({
      regressions: ["truncated-json"],
      improvements: [],
      new: [],
    });
  });
});

test("a recorded failure that now passes is an improvement", async () => {
  for (const previous of ["fail", "error"] as const) {
    await withDir(async (dir) => {
      const file = path.join(dir, "baseline.json");
      writeFileSync(
        file,
        baselineFile({ "trailing-comma-in-string": previous }),
      );
      const result = await run([
        "run",
        "--adapter",
        "reference-naive",
        "--scenario",
        "trailing-comma-in-string",
        "--baseline",
        file,
      ]);
      expect(result.code, previous).toBe(0);
      expect(result.stderr, previous).toBe("");
      expect(result.stdout, previous).toContain(
        "1 passed, 0 failed, 0 errors, 0 not covered\n\nimprovements:\n  trailing-comma-in-string\nrerun with --update-baseline to record improvements\n",
      );
      expect(result.stdout, previous).not.toContain("\nregressions:");
      expect(result.stdout, previous).not.toContain("\nnew:");
    });
  }
});

test("a scenario missing from the baseline is new", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "baseline.json");
    writeFileSync(file, baselineFile({ "trailing-comma-in-string": "pass" }));
    const loose = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--scenario",
      "truncated-json",
      "--baseline",
      file,
    ]);
    expect(loose.code).toBe(0);
    expect(loose.stdout).toContain("\nnew:\n  truncated-json\n");
    expect(loose.stdout).not.toContain("\nregressions:");
    expect(loose.stderr).toBe("warning: new scenario truncated-json is fail\n");

    const strict = await run([
      "run",
      "--strict",
      "--adapter",
      "reference-naive",
      "--scenario",
      "truncated-json",
      "--baseline",
      file,
      "--json",
    ]);
    expect(strict.code).toBe(1);
    expect(strict.stderr).toBe("");
    expect(readReport(strict.stdout).baseline).toEqual({
      regressions: ["truncated-json"],
      improvements: [],
      new: ["truncated-json"],
    });

    const empty = path.join(dir, "empty.json");
    writeFileSync(empty, baselineFile({}));
    const freshPass = await run([
      "run",
      "--strict",
      "--adapter",
      "reference-naive",
      "--scenario",
      "trailing-comma-in-string",
      "--baseline",
      empty,
    ]);
    expect(freshPass.code).toBe(0);
    expect(freshPass.stderr).toBe("");
    expect(freshPass.stdout).toContain("\nnew:\n  trailing-comma-in-string\n");
    expect(freshPass.stdout).not.toContain("\nregressions:");
  });
});

test("a baseline scenario this version does not run is ignored", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "baseline.json");
    writeFileSync(
      file,
      baselineFile({
        "m-retired": "pass",
        "a-retired": "fail",
        "trailing-comma-in-string": "pass",
      }),
    );
    const result = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--scenario",
      "trailing-comma-in-string",
      "--baseline",
      file,
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(
      "note: ignoring baseline scenario a-retired; it is not in this version\nnote: ignoring baseline scenario m-retired; it is not in this version\n",
    );
    expect(result.stdout).not.toContain("retired");
    expect(result.stdout).not.toContain("\nregressions:");
  });
});

test("a bad baseline file exits 2", async () => {
  await withDir(async (dir) => {
    const missing = path.join(dir, "missing.json");
    const invalid = path.join(dir, "invalid.json");
    const empty = path.join(dir, "empty.json");
    const listed = path.join(dir, "listed.json");
    const status = path.join(dir, "status.json");
    writeFileSync(invalid, "{\n");
    writeFileSync(empty, "{}\n");
    writeFileSync(
      listed,
      `${JSON.stringify({
        gauntletVersion: "9.9.9",
        adapter: "reference-naive",
        scenarios: [],
      })}\n`,
    );
    writeFileSync(status, baselineFile({ "truncated-json": "nope" }));
    const cases = [
      {
        file: missing,
        stderr: `baseline file not found: ${missing}\n`,
      },
      {
        file: dir,
        stderrPrefix: `could not read baseline ${dir}: `,
      },
      {
        file: invalid,
        stderrPrefix: `invalid baseline ${invalid}: `,
      },
      {
        file: empty,
        stderr: `invalid baseline ${empty}: missing gauntletVersion\n`,
      },
      {
        file: listed,
        stderr: `invalid baseline ${listed}: scenarios must be an object\n`,
      },
      {
        file: status,
        stderr: `invalid baseline ${status}: scenario truncated-json has an invalid status\n`,
      },
    ];
    for (const item of cases) {
      const result = await run([
        "run",
        "--adapter",
        "reference-naive",
        "--scenario",
        "truncated-json",
        "--baseline",
        item.file,
      ]);
      expect(result.code, item.file).toBe(2);
      expect(result.stdout, item.file).toBe("");
      expect(result.stderr.trim().split("\n"), item.file).toHaveLength(1);
      if (item.stderr !== undefined) {
        expect(result.stderr, item.file).toBe(item.stderr);
      } else if (item.stderrPrefix !== undefined) {
        expect(result.stderr.startsWith(item.stderrPrefix), item.file).toBe(
          true,
        );
      }
    }
  });
});

test("baseline and update-baseline together exit 2", async () => {
  const result = await run([
    "run",
    "--adapter",
    "reference-naive",
    "--baseline",
    "baseline.json",
    "--update-baseline",
    "next.json",
  ]);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "--baseline and --update-baseline are mutually exclusive\n",
  );
});

test("update-baseline exits 2 when the file cannot be written", async () => {
  await withDir(async (dir) => {
    const result = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--update-baseline",
      dir,
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("truncated-json");
    expect(result.stderr.startsWith(`could not write baseline ${dir}: `)).toBe(
      true,
    );
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  });
});

test("text and json reports list baseline groups", () => {
  const results = [
    {
      id: "truncated-json",
      title: "Truncated JSON arguments",
      category: "json" as const,
      status: "fail" as const,
      reason: "executed a truncated tool call",
    },
    {
      id: "trailing-comma-in-string",
      title: "Trailing comma inside a string",
      category: "json" as const,
      status: "pass" as const,
      reason: "refused the trailing comma call",
    },
    {
      id: "future-case",
      title: "Future case",
      category: "json" as const,
      status: "error" as const,
      reason: "adapter threw",
    },
  ];
  const summary = {
    regressions: ["truncated-json", "future-case"],
    improvements: ["trailing-comma-in-string"],
    added: ["future-case"],
    removed: ["retired"],
  };
  const text = formatRun("reference-naive", results, summary);
  expect(text).toContain(
    "1 passed, 1 failed, 1 errors, 0 not covered\n\nregressions:\n  truncated-json\n  future-case\nimprovements:\n  trailing-comma-in-string\nnew:\n  future-case\nrerun with --update-baseline to record improvements\n",
  );
  expect(text).not.toContain("retired");
  const report = readReport(
    formatJson("reference-naive", "0.1.1", results, summary),
  );
  expect(Object.keys(report.baseline)).toEqual([
    "regressions",
    "improvements",
    "new",
  ]);
  expect(report.baseline).toEqual({
    regressions: ["truncated-json", "future-case"],
    improvements: ["trailing-comma-in-string"],
    new: ["future-case"],
  });
  expect(formatRun("reference-naive", results)).toBe(
    formatRun("reference-naive", results, {
      regressions: [],
      improvements: [],
      added: [],
      removed: ["retired"],
    }),
  );
  const plain = JSON.parse(formatJson("reference-naive", "0.1.1", results)) as {
    baseline?: unknown;
  };
  expect(plain.baseline).toBeUndefined();
});

function expectedNaiveBaseline(): string {
  const statuses: Record<string, string> = {};
  for (const id of Object.keys(NAIVE_STATUS).sort()) {
    const status = NAIVE_STATUS[id as keyof typeof NAIVE_STATUS];
    statuses[id] = status;
  }
  return `${JSON.stringify(
    {
      gauntletVersion: packageVersion(),
      adapter: "reference-naive",
      scenarios: statuses,
    },
    null,
    2,
  )}\n`;
}

function baselineFile(scenarioStatuses: Record<string, string>): string {
  return `${JSON.stringify({
    gauntletVersion: "9.9.9",
    adapter: "reference-naive",
    scenarios: scenarioStatuses,
  })}\n`;
}

function packageVersion(): string {
  const raw = readFileSync("package.json", "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    throw new Error("package.json missing version");
  }
  return parsed.version;
}

async function run(argv: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runCli(argv, stdout.stream, stderr.stream);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function withDir(check: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-baseline-"));
  try {
    await check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readReport(text: string): {
  scenarios: { id: string; status: string }[];
  baseline: { regressions: string[]; improvements: string[]; new: string[] };
} & Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new Error("report was not an object");
  }
  if (!("baseline" in value)) throw new Error("report missing baseline");
  const baseline = value.baseline;
  if (
    typeof baseline !== "object" ||
    baseline === null ||
    Array.isArray(baseline)
  ) {
    throw new Error("baseline was not an object");
  }
  if (
    !("regressions" in baseline) ||
    !("improvements" in baseline) ||
    !("new" in baseline)
  ) {
    throw new Error("baseline missing lists");
  }
  const regressions = stringList(baseline.regressions, "regressions");
  const improvements = stringList(baseline.improvements, "improvements");
  const added = stringList(baseline.new, "new");
  if (!("scenarios" in value) || !Array.isArray(value.scenarios)) {
    throw new Error("report missing scenarios");
  }
  const scenarios: { id: string; status: string }[] = [];
  for (const row of value.scenarios) {
    if (typeof row !== "object" || row === null) {
      throw new Error("scenario was not an object");
    }
    if (!("id" in row) || !("status" in row)) {
      throw new Error("scenario missing fields");
    }
    if (typeof row.id !== "string" || typeof row.status !== "string") {
      throw new Error("scenario fields were not strings");
    }
    scenarios.push({ id: row.id, status: row.status });
  }
  return {
    ...value,
    scenarios,
    baseline: { regressions, improvements, new: added },
  };
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} was not a list of strings`);
  }
  return value;
}

function memoryStream(): { stream: Writable; text: () => string } {
  let body = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  return { stream, text: () => body };
}
