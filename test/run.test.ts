import { expect, test } from "vitest";
import { asRunOutput } from "../src/output.ts";
import { runScenario } from "../src/run.ts";
import { scenarios } from "../src/scenarios/index.ts";
import type { Adapter, RunOutput, Scenario } from "../src/types.ts";

function scenario(id: string): Scenario {
  const found = scenarios.find((item) => item.id === id);
  if (!found) throw new Error(`missing scenario ${id}`);
  return found;
}

function adapterReturning(value: unknown): Adapter {
  return {
    name: "probe",
    // The cast is the point. A JavaScript adapter can return anything.
    run: () => Promise.resolve(value as RunOutput),
  };
}

test("a value that is not a RunOutput is an error, not a crash in the check", async () => {
  const values: unknown[] = [
    undefined,
    null,
    "refused",
    {},
    { status: "ok" },
    { status: "refused" },
    { status: "executed", result: "x" },
    { status: "executed", call: { name: "read_file" }, result: "x" },
    {
      status: "executed",
      call: { name: "read_file", arguments: [] },
      result: "x",
    },
    {
      status: "executed",
      call: { name: "read_file", arguments: {} },
      result: 1,
    },
  ];
  for (const value of values) {
    const result = await runScenario(
      adapterReturning(value),
      scenario("truncated-json"),
    );
    expect(result.status, JSON.stringify(value)).toBe("error");
    expect(result.reason).toBe(
      "adapter returned a value that is not a RunOutput",
    );
  }
});

test("asRunOutput copies __proto__ as an own key", () => {
  const output = asRunOutput(
    JSON.parse(
      '{"status":"executed","call":{"name":"write_file","arguments":{"__proto__":{"path":"x"}}},"result":""}',
    ),
  );
  if (output?.status !== "executed") throw new Error("expected executed");
  expect(Object.keys(output.call.arguments)).toEqual(["__proto__"]);
  expect(output.call.arguments.path).toBeUndefined();
});

test("an adapter that never settles is an error after the timeout", async () => {
  const hung: Adapter = {
    name: "hung",
    run: () => new Promise<RunOutput>(() => {}),
  };
  const started = Date.now();
  const result = await runScenario(hung, scenario("truncated-json"), {
    timeoutMs: 50,
  });
  expect(result.status).toBe("error");
  expect(result.reason).toBe("adapter timed out after 50ms");
  expect(Date.now() - started).toBeLessThan(5000);
});

test("an adapter that throws before it returns a promise is an error", async () => {
  const thrower: Adapter = {
    name: "thrower",
    run() {
      throw new Error("boom\nsecond line");
    },
  };
  const result = await runScenario(thrower, scenario("duplicate-keys"), {
    timeoutMs: 1000,
  });
  expect(result.status).toBe("error");
  expect(result.reason).toBe("boom");
  expect(result.probes).toHaveLength(1);
  expect(result.probes?.[0]?.outcome).toEqual({
    status: "error",
    reason: "boom",
  });
});

test("a result records every probe and what came back", async () => {
  const refuser = adapterReturning({ status: "refused", reason: "no" });
  const target = scenario("duplicate-keys");
  const result = await runScenario(refuser, target);
  expect(result.status).toBe("pass");
  expect(result.probes).toHaveLength(target.probes.length);
  for (const probe of result.probes ?? []) {
    expect(probe.raw).toContain("write_file");
    expect(probe.outcome).toEqual({ status: "refused", reason: "no" });
  }
});

test("every scenario says what a correct adapter does", () => {
  const ids = new Set<string>();
  for (const item of scenarios) {
    expect(ids.has(item.id), item.id).toBe(false);
    ids.add(item.id);
    expect(item.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const text of [item.title, item.summary, item.expected]) {
      expect(text, item.id).toMatch(/\S/);
      expect(text.includes("\n"), item.id).toBe(false);
    }
    expect(item.probes.length, item.id).toBeGreaterThan(0);
    expect(item.prepare === undefined, item.id).toBe(item.setup === undefined);
  }
});
