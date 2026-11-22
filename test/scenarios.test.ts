import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  referenceHardened,
  referenceNaive,
} from "../src/adapters/reference.ts";
import { runScenario } from "../src/run.ts";
import { scenarios } from "../src/scenarios/index.ts";
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

// A parser that does not repair is safe from a repair bug, and JSON.parse
// does not recurse. Those are passes the naive adapter earns.
const NAIVE_PASSES = [
  "trailing-comma-in-string",
  "duplicate-keys-after-repair",
  "deep-nesting",
];

test("reference-naive fails every scenario it does not survive by being strict", async () => {
  const failed: string[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(referenceNaive, scenario);
    const expected = NAIVE_PASSES.includes(scenario.id) ? "pass" : "fail";
    expect(result.status, `${scenario.id}: ${result.reason}`).toBe(expected);
    expect(result.reason).toMatch(/\S/);
    expect(result.reason.includes("\n")).toBe(false);
    if (expected === "fail") failed.push(result.id);
  }
  expect(failed).toEqual(ids.filter((id) => !NAIVE_PASSES.includes(id)));
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

test("a refusal after a write fails the other scenarios that accept a refusal", async () => {
  const cases: {
    id: string;
    file: string;
    body: string;
    reason: string;
  }[] = [
    {
      id: "truncated-json",
      file: "notes.txt",
      body: "mutated\n",
      reason: "refused after writing notes.txt",
    },
    {
      id: "duplicate-keys",
      file: "side.txt",
      body: "x",
      reason: "refused after writing a file",
    },
    {
      id: "unicode-zero-width-path",
      file: "../outside.txt",
      body: "mutated\n",
      reason: "refused after writing outside the workspace",
    },
    {
      id: "path-escape",
      file: "../leak.txt",
      body: "secret\n",
      reason: "refused after writing a file",
    },
    {
      id: "path-symlink",
      file: "leak.txt",
      body: "secret\n",
      reason: "refused after writing a file",
    },
    {
      id: "stream-aborted",
      file: "side.txt",
      body: "aborted-write",
      reason: "refused after writing a file",
    },
    {
      id: "oversized-argument",
      file: "notes.txt",
      body: "mutated\n",
      reason: "refused after writing notes.txt",
    },
  ];
  for (const item of cases) {
    const scenario = scenarios.find((entry) => entry.id === item.id);
    if (!scenario) throw new Error(`missing ${item.id}`);
    const adapter: Adapter = {
      name: "write-then-refuse",
      run(input) {
        writeFileSync(path.join(input.sandboxDir, item.file), item.body);
        return Promise.resolve({ status: "refused", reason: "no" });
      },
    };
    const result = await runScenario(adapter, scenario);
    expect(result.status, item.id).toBe("fail");
    expect(result.reason, item.id).toBe(item.reason);
  }
});

test("prompt-injection fails when the nested write uses another name", async () => {
  const scenario = scenarios.find(
    (item) => item.id === "prompt-injection-result",
  );
  if (!scenario) throw new Error("missing prompt-injection-result");
  const adapter: Adapter = {
    name: "write-then-read",
    run(input) {
      writeFileSync(path.join(input.sandboxDir, "evil.txt"), "pwned");
      return Promise.resolve({
        status: "executed",
        call: { name: "read_file", arguments: { path: "page.txt" } },
        result: "page",
      });
    },
  };
  const result = await runScenario(adapter, scenario);
  expect(result.status).toBe("fail");
  expect(result.reason).toBe("tool result triggered write_file");
});

test("not-covered is its own status and does not change the sandbox check", async () => {
  const scenario = scenarios.find((item) => item.id === "stream-aborted");
  if (!scenario) throw new Error("missing stream-aborted");
  const adapter: Adapter = {
    name: "gap",
    run() {
      return Promise.resolve({
        status: "not-covered",
        reason:
          "abort check is in turn-engine.ts, which this shim does not call",
      });
    },
  };
  const result = await runScenario(adapter, scenario);
  expect(result.status).toBe("not-covered");
  expect(result.reason).toBe(
    "abort check is in turn-engine.ts, which this shim does not call",
  );
  expect(result.id).toBe("stream-aborted");
});

test("trailing-comma-in-string fails when the adapter writes and then refuses", async () => {
  const scenario = scenarios.find(
    (item) => item.id === "trailing-comma-in-string",
  );
  if (!scenario) throw new Error("missing trailing-comma-in-string");
  const adapter: Adapter = {
    name: "write-then-refuse",
    run(input) {
      writeFileSync(
        path.join(input.sandboxDir, "notes.txt"),
        "x = [1, 2,] y = {a: 1,}",
      );
      return Promise.resolve({ status: "refused", reason: "no" });
    },
  };
  const result = await runScenario(adapter, scenario);
  expect(result.status).toBe("fail");
  expect(result.reason).toBe("refused after writing notes.txt");
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
