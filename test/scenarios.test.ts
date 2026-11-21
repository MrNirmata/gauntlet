import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

test("reference-naive fails every scenario", async () => {
  const failed: string[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(referenceNaive, scenario);
    expect(result.status, `${scenario.id}: ${result.reason}`).toBe("fail");
    expect(result.reason).toMatch(/\S/);
    expect(result.reason.includes("\n")).toBe(false);
    failed.push(result.id);
  }
  expect(failed).toEqual(ids);
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
