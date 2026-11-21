import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { formatJson, formatRun } from "../src/format.ts";
import { scenarios } from "../src/scenarios.ts";

test("list prints every scenario id", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runCli(["list"], stdout.stream, stderr.stream);
  expect(code).toBe(0);
  for (const scenario of scenarios) {
    expect(stdout.text()).toContain(scenario.id);
  }
  expect(stderr.text()).toBe("");
});

test("hardened json run passes", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runCli(
    ["run", "--adapter", "reference-hardened", "--json"],
    stdout.stream,
    stderr.stream,
  );
  expect(code).toBe(0);
  const report = readReport(stdout.text());
  expect(report.adapter).toBe("reference-hardened");
  expect(report.gauntletVersion).toBe(packageVersion());
  expect(report.scenarios).toHaveLength(scenarios.length);
  expect(report.scenarios.map((scenario) => scenario.id)).toEqual(
    scenarios.map((scenario) => scenario.id),
  );
  expect(report.totals).toEqual({
    pass: scenarios.length,
    fail: 0,
    error: 0,
    notCovered: 0,
  });
  expect(stderr.text()).toBe("");
});

test("naive truncated-json run fails", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runCli(
    [
      "run",
      "--adapter",
      "reference-naive",
      "--scenario",
      "truncated-json",
      "--json",
    ],
    stdout.stream,
    stderr.stream,
  );
  expect(code).toBe(1);
  const report = readReport(stdout.text());
  expect(report.scenarios).toHaveLength(1);
  expect(report.scenarios[0]?.status).toBe("fail");
  expect(report.scenarios[0]?.id).toBe("truncated-json");
  expect(report.totals).toEqual({ pass: 0, fail: 1, error: 0, notCovered: 0 });
});

test("not-covered is counted apart from pass and fail", () => {
  const results = [
    {
      id: "stream-aborted",
      title: "Stream aborted mid tool call",
      category: "stream" as const,
      status: "not-covered" as const,
      reason: "abort check is in turn-engine.ts, which this shim does not call",
    },
    {
      id: "truncated-json",
      title: "Truncated JSON arguments",
      category: "json" as const,
      status: "pass" as const,
      reason: "refused truncated JSON",
    },
  ];
  const text = formatRun("nanocoder", results);
  expect(text).toContain("not-covered");
  expect(text).toContain("1 passed, 0 failed, 0 errors, 1 not covered");
  const report = readReport(formatJson("nanocoder", "0.1.0", results));
  expect(report.totals).toEqual({ pass: 1, fail: 0, error: 0, notCovered: 1 });
  expect(report.scenarios[0]?.status).toBe("not-covered");
});

test("unknown adapter exits 2", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runCli(
    ["run", "--adapter", "nope"],
    stdout.stream,
    stderr.stream,
  );
  expect(code).toBe(2);
  expect(stderr.text()).toContain("unknown adapter nope");
  expect(stdout.text()).toBe("");
});

test("tsx cli list smoke", () => {
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const result = spawnSync(tsx, ["src/cli.ts", "list"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("whitespace-padded-args");
});

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

function readReport(text: string): {
  adapter: string;
  gauntletVersion: string;
  scenarios: { id: string; category: string; status: string; reason: string }[];
  totals: { pass: number; fail: number; error: number; notCovered: number };
} {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null)
    throw new Error("report was not an object");
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    keys[0] !== "adapter" ||
    keys[1] !== "gauntletVersion" ||
    keys[2] !== "scenarios" ||
    keys[3] !== "totals"
  ) {
    throw new Error("report keys were not the stable schema");
  }
  if (
    !("adapter" in value) ||
    !("gauntletVersion" in value) ||
    !("scenarios" in value) ||
    !("totals" in value)
  ) {
    throw new Error("report missing fields");
  }
  const { adapter, gauntletVersion, scenarios: rows, totals } = value;
  if (typeof adapter !== "string" || typeof gauntletVersion !== "string") {
    throw new Error("report names were not strings");
  }
  if (typeof totals !== "object" || totals === null || !Array.isArray(rows)) {
    throw new Error("report had the wrong shape");
  }
  if (
    !("pass" in totals) ||
    !("fail" in totals) ||
    !("error" in totals) ||
    !("notCovered" in totals)
  ) {
    throw new Error("totals missing counts");
  }
  const { pass, fail, error, notCovered } = totals;
  if (
    typeof pass !== "number" ||
    typeof fail !== "number" ||
    typeof error !== "number" ||
    typeof notCovered !== "number"
  ) {
    throw new Error("totals counts were not numbers");
  }
  const scenarios: {
    id: string;
    category: string;
    status: string;
    reason: string;
  }[] = [];
  for (const result of rows) {
    if (typeof result !== "object" || result === null)
      throw new Error("scenario was not an object");
    const scenarioKeys = Object.keys(result);
    if (
      scenarioKeys.length !== 4 ||
      scenarioKeys[0] !== "id" ||
      scenarioKeys[1] !== "category" ||
      scenarioKeys[2] !== "status" ||
      scenarioKeys[3] !== "reason"
    ) {
      throw new Error("scenario keys were not the stable schema");
    }
    if (
      !("id" in result) ||
      !("category" in result) ||
      !("status" in result) ||
      !("reason" in result)
    ) {
      throw new Error("scenario missing fields");
    }
    const { id, category, status, reason } = result;
    if (
      typeof id !== "string" ||
      typeof category !== "string" ||
      typeof status !== "string" ||
      typeof reason !== "string"
    ) {
      throw new Error("scenario fields were not strings");
    }
    scenarios.push({ id, category, status, reason });
  }
  return {
    adapter,
    gauntletVersion,
    scenarios,
    totals: { pass, fail, error, notCovered },
  };
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
