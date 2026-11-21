import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  referenceHardened,
  referenceNaive,
} from "../src/adapters/reference.ts";
import { runScenario } from "../src/run.ts";
import { scenarios } from "../src/scenarios.ts";
import type { Adapter } from "../src/types.ts";

const ids = scenarios.map((scenario) => scenario.id);

test("reference-hardened passes every scenario", async () => {
  const passed: string[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(referenceHardened, scenario);
    expect(result.status, `${scenario.id}: ${result.reason}`).toBe("pass");
    expect(result.reason).toMatch(/\S/);
    expect(result.reason.includes("\n")).toBe(false);
    passed.push(result.id);
  }
  expect(passed).toEqual(ids);
});

test("reference-naive fails every scenario except trailing-comma-in-string", async () => {
  const failed: string[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(referenceNaive, scenario);
    const expected =
      scenario.id === "trailing-comma-in-string" ? "pass" : "fail";
    expect(result.status, `${scenario.id}: ${result.reason}`).toBe(expected);
    expect(result.reason).toMatch(/\S/);
    expect(result.reason.includes("\n")).toBe(false);
    if (expected === "fail") failed.push(result.id);
  }
  expect(failed).toEqual(ids.filter((id) => id !== "trailing-comma-in-string"));
});

test("a thrown adapter error deletes the sandbox", async () => {
  const scenario = scenarios[0];
  if (!scenario) throw new Error("expected a scenario");
  let sandboxDir = "";
  const adapter: Adapter = {
    name: "probe",
    run(input) {
      sandboxDir = input.sandboxDir;
      throw new Error("boom");
    },
  };
  const result = await runScenario(adapter, scenario);
  expect(result.status).toBe("error");
  expect(result.reason).toBe("boom");
  expect(sandboxDir.startsWith(os.tmpdir())).toBe(true);
  expect(existsSync(sandboxDir)).toBe(false);
});

test("a refusal deletes the sandbox", async () => {
  const scenario = scenarios[0];
  if (!scenario) throw new Error("expected a scenario");
  let sandboxDir = "";
  const adapter: Adapter = {
    name: "probe",
    run(input) {
      sandboxDir = input.sandboxDir;
      return Promise.resolve({ status: "refused", reason: "no" });
    },
  };
  const result = await runScenario(adapter, scenario);
  expect(result.status).toBe("fail");
  expect(sandboxDir.startsWith(os.tmpdir())).toBe(true);
  expect(existsSync(sandboxDir)).toBe(false);
  expect(existsSync(sandboxDir.replace(/workspace$/, ""))).toBe(false);
});

async function writtenByHardened(raw: string, name: string) {
  const sandboxDir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-"));
  try {
    const output = await referenceHardened.run({
      raw,
      sandboxDir,
      aborted: false,
    });
    const file = path.join(sandboxDir, name);
    const written = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    return { output, written };
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}

async function runHardened(raw: string) {
  const sandboxDir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-"));
  try {
    const output = await referenceHardened.run({
      raw,
      sandboxDir,
      aborted: false,
    });
    return { output, stolen: existsSync(path.join(sandboxDir, "stolen.txt")) };
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}

test("string arguments are unwrapped once, not recursively", async () => {
  const once = JSON.stringify({ path: "notes.txt" });
  const twice = JSON.stringify(once);
  const single = await runHardened(
    JSON.stringify({ name: "read_file", arguments: once }),
  );
  expect(single.output).toMatchObject({
    status: "executed",
    call: { arguments: { path: "notes.txt" } },
  });
  const triple = await runHardened(
    JSON.stringify({ name: "read_file", arguments: twice }),
  );
  expect(triple.output.status).toBe("refused");
});

test("duplicate keys inside string arguments are still refused", async () => {
  const inner = '{"path":"notes.txt","path":"stolen.txt","content":"x"}';
  const result = await runHardened(
    JSON.stringify({ name: "write_file", arguments: inner }),
  );
  expect(result.output.status).toBe("refused");
  expect(result.stolen).toBe(false);
});

test("every duplicate-keys probe is refused and does not write stolen.txt", async () => {
  const scenario = scenarios.find((item) => item.id === "duplicate-keys");
  if (!scenario) throw new Error("missing duplicate-keys scenario");
  for (const probe of scenario.probes) {
    const raw = probe({
      rootDir: "",
      workspaceDir: "",
      outsideFile: "",
    });
    const result = await runHardened(raw);
    expect(result.output, raw).toEqual({
      status: "refused",
      reason: "duplicate key",
    });
    expect(result.stolen, raw).toBe(false);
  }
});

test("trailing-comma repair keeps an escaped quote before a comma", async () => {
  const content = 'say ",} hi';
  const raw = `{"name":"write_file","arguments":{"path":"out.txt","content":${JSON.stringify(content)},}}`;
  const result = await writtenByHardened(raw, "out.txt");
  expect(result.output).toMatchObject({
    status: "executed",
    call: {
      name: "write_file",
      arguments: { path: "out.txt", content },
    },
  });
  expect(result.written).toBe(content);
});

test("trailing-comma repair keeps a backslash at the end of a string", async () => {
  const content = "foo\\";
  const raw = `{"name":"write_file","arguments":{"path":"out.txt","content":${JSON.stringify(content)},}}`;
  const result = await writtenByHardened(raw, "out.txt");
  expect(result.output).toMatchObject({
    status: "executed",
    call: {
      name: "write_file",
      arguments: { path: "out.txt", content },
    },
  });
  expect(result.written).toBe(content);
});

test("trailing-comma repair keeps a comma inside a string followed by }", async () => {
  const content = "a,}b";
  const raw = `{"name":"write_file","arguments":{"path":"out.txt","content":${JSON.stringify(content)},}}`;
  const result = await writtenByHardened(raw, "out.txt");
  expect(result.output).toMatchObject({
    status: "executed",
    call: {
      name: "write_file",
      arguments: { path: "out.txt", content },
    },
  });
  expect(result.written).toBe(content);
});

test("trailing-comma repair strips nested-array commas and keeps string commas", async () => {
  const content = "keep,]";
  const raw = `{"name":"write_file","arguments":{"path":"out.txt","content":${JSON.stringify(content)},"rows":[[1, 2, ], [3, ]],}}`;
  const result = await writtenByHardened(raw, "out.txt");
  expect(result.output).toMatchObject({
    status: "executed",
    call: {
      name: "write_file",
      arguments: {
        path: "out.txt",
        content,
        rows: [[1, 2], [3]],
      },
    },
  });
  expect(result.written).toBe(content);
});

test("an escaped arguments key with unique keys still executes", async () => {
  const raw =
    '{"name":"write_file","\\u0061rguments":{"path":"out.txt","content":"ok"}}';
  const result = await runHardened(raw);
  expect(result.output).toMatchObject({
    status: "executed",
    call: { name: "write_file", arguments: { path: "out.txt", content: "ok" } },
  });
  expect(result.stolen).toBe(false);
});
