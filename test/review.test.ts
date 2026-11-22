import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { referenceHardened } from "../src/adapters/reference.ts";
import { runCli } from "../src/cli.ts";
import { formatDetails, formatJUnit, formatRun } from "../src/format.ts";
import { runAll, runScenario } from "../src/run.ts";
import { scenarios } from "../src/scenarios/index.ts";
import { formatMarkdownSummary } from "../src/summary.ts";
import type { Adapter, RunOutput, Scenario } from "../src/types.ts";

const ESC = String.fromCharCode(0x1b);
const BACKSLASH = String.fromCharCode(0x5c);
const CR = String.fromCharCode(0x0d);

async function run(
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runCli(argv, stdout.stream, stderr.stream);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
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

function scenario(id: string): Scenario {
  const found = scenarios.find((item) => item.id === id);
  if (!found) throw new Error(`missing scenario ${id}`);
  return found;
}

function parse(raw: string): { name: string; path: string; content: string } {
  const value = JSON.parse(raw) as {
    name: string;
    arguments: { path: string; content?: string };
  };
  return {
    name: value.name,
    path: value.arguments.path,
    content: value.arguments.content ?? "",
  };
}

test("a filtered run cannot replace the baseline", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-test-"));
  const file = path.join(dir, "baseline.json");
  try {
    for (const filter of [
      ["--scenario", "truncated-json"],
      ["--category", "path"],
    ]) {
      const result = await run([
        "run",
        "--adapter",
        "reference-hardened",
        ...filter,
        "--update-baseline",
        file,
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(
        "--update-baseline records every scenario; remove --scenario, --category, and --tier\n",
      );
    }
    expect(existsSync(file)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a flag value that cannot mean anything exits 2", async () => {
  const base = ["run", "--adapter", "reference-hardened"];
  const cases: [string[], string][] = [
    [[...base, "--scenario", ""], "missing --scenario value\n"],
    [[...base, "--scenario", " , "], "missing --scenario value\n"],
    [[...base, "--category", ","], "missing --category value\n"],
    [[...base, "--timeout", "2147483648"], "invalid --timeout\n"],
    [[...base, "--timeout", "0"], "invalid --timeout\n"],
    [["run", "--http", "not-a-url"], "invalid --http url not-a-url\n"],
    [["run", "--http", "ftp://host/x"], "invalid --http url ftp://host/x\n"],
  ];
  for (const [argv, message] of cases) {
    const result = await run(argv);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.stderr, argv.join(" ")).toBe(message);
    expect(result.stdout).toBe("");
  }
  const limit = await run([
    ...base,
    "--timeout",
    "2147483647",
    "--scenario",
    "truncated-json",
  ]);
  expect(limit.code).toBe(0);
});

test("help is found after a command and not inside a value", async () => {
  for (const argv of [
    ["list", "--help"],
    ["show", "-h"],
    ["run", "--adapter", "x", "-h"],
  ]) {
    const result = await run(argv);
    expect(result.code, argv.join(" ")).toBe(0);
    expect(result.stdout).toContain("exit codes:");
  }
  const named = await run([
    "run",
    "--name",
    "-h",
    "--adapter",
    "reference-hardened",
    "--scenario",
    "truncated-json",
  ]);
  expect(named.code).toBe(0);
  expect(named.stdout).toContain("adapter: -h\n");
});

test("text from an adapter cannot draw on the terminal", async () => {
  const noisy: Adapter = {
    name: `loud${ESC}[2Jname`,
    run(input) {
      if (input.aborted) {
        return Promise.resolve({
          status: "not-covered",
          reason: `${ESC}[32mALL GOOD${ESC}[0m${CR}forged-row  json  pass`,
        });
      }
      return Promise.resolve({
        status: "executed",
        call: { name: `read_file${ESC}[31m${CR}fake`, arguments: {} },
        result: `x${ESC}[2J`,
      });
    },
  };
  const results = await runAll(noisy, [
    scenario("stream-aborted"),
    scenario("truncated-json"),
  ]);
  const text =
    formatRun(noisy.name, results) + formatDetails(results, scenarios);
  expect(text).not.toContain(ESC);
  expect(text).not.toContain(CR);
  expect(text).toContain("adapter: loud\\u001b[2Jname\n");
  expect(text).toContain("not-covered  \\u001b[32mALL GOOD\\u001b[0m");
  expect(text).toContain("executed read_file\\u001b[31m\\u000dfake {} => ");
  const thrower: Adapter = {
    name: "thrower",
    run() {
      throw new Error(`boom ${ESC}[31mred${CR}second row`);
    },
  };
  const thrown = await runAll(thrower, [scenario("truncated-json")]);
  expect(thrown[0]?.reason).toBe(`boom ${ESC}[31mred`);
  expect(formatRun("thrower", thrown)).toContain(
    "error   boom \\u001b[31mred\n",
  );
});

test("junit keeps characters outside the basic plane", () => {
  const xml = formatJUnit("a", [
    {
      id: "x",
      title: "x",
      category: "json",
      status: "fail",
      reason: `smile ${String.fromCodePoint(0x1f600)} lone ${String.fromCharCode(0xd800)} bell ${String.fromCharCode(7)}`,
    },
  ]);
  expect(xml).toContain(
    `<failure message="smile ${String.fromCodePoint(0x1f600)} lone ? bell ?"/>`,
  );
});

test("the job summary does not turn __proto__ into bold text", () => {
  const summary = formatMarkdownSummary({
    adapter: "a",
    gauntletVersion: "0",
    scenarios: [
      {
        id: "proto-key-arguments",
        category: "json",
        status: "fail",
        reason: "__proto__ supplied *the* path",
      },
      {
        id: "x",
        category: "json",
        status: "fail",
        // A backslash already in front of a character that gets escaped.
        reason: ["a", "_b", "|c", "*d"].join(BACKSLASH),
      },
    ],
    totals: { pass: 0, fail: 2, error: 0, notCovered: 0 },
  });
  const twice = BACKSLASH + BACKSLASH + BACKSLASH;
  expect(summary).toContain(`| a${twice}_b${twice}|c${twice}*d |`);
  expect(summary).toContain("| \\_\\_proto\\_\\_ supplied \\*the\\* path |");
});

test("one uncovered probe does not hide what the others did", async () => {
  const target = scenario("path-escape-write");
  const masks: Adapter = {
    name: "masks",
    async run(input) {
      const call = parse(input.raw);
      if (call.path !== "../outside.txt") {
        return { status: "not-covered", reason: "not measured" };
      }
      writeFileSync(path.resolve(input.sandboxDir, call.path), call.content);
      return {
        status: "executed",
        call: { name: call.name, arguments: { path: call.path } },
        result: "wrote",
      };
    },
  };
  expect(await runScenario(masks, target)).toMatchObject({
    status: "fail",
    reason: "overwrote a file outside the workspace",
  });
  const honest: Adapter = {
    name: "honest",
    async run(input) {
      return parse(input.raw).path === "../outside.txt"
        ? { status: "refused", reason: "no" }
        : { status: "not-covered", reason: "not measured" };
    },
  };
  expect(await runScenario(honest, target)).toMatchObject({
    status: "not-covered",
    reason: "not measured",
  });
});

test("a sandbox that cannot be deleted does not end the run", async () => {
  const dirs: string[] = [];
  const locks: Adapter = {
    name: "locks",
    async run(input) {
      const locked = path.join(input.sandboxDir, "locked");
      if (!existsSync(locked)) {
        mkdirSync(locked);
        writeFileSync(path.join(locked, "f"), "x");
        chmodSync(locked, 0o000);
        dirs.push(path.dirname(input.sandboxDir));
      }
      return { status: "refused", reason: "no" };
    },
  };
  const results = await runAll(locks, [
    scenario("truncated-json"),
    scenario("trailing-comma-json"),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fail", "fail"]);
  expect(dirs).toHaveLength(2);
  for (const dir of dirs) expect(existsSync(dir), dir).toBe(false);
});

test("the exec limit holds when a grandchild keeps the pipe open", async () => {
  const reply = '{"status":"refused","reason":"ok"}';
  const started = Date.now();
  const held = await run([
    "run",
    "--exec",
    `(sleep 6.4242 &) ; echo '${reply}'`,
    "--scenario",
    "truncated-json",
    "--json",
  ]);
  expect(Date.now() - started).toBeLessThan(4000);
  expect(JSON.parse(held.stdout)).toMatchObject({
    scenarios: [{ status: "pass", reason: "refused truncated JSON" }],
  });
  const again = Date.now();
  const hung = await run([
    "run",
    "--exec",
    "(sleep 6.4343 &) ; sleep 6.4343",
    "--scenario",
    "truncated-json",
    "--timeout",
    "300",
    "--json",
  ]);
  expect(Date.now() - again).toBeLessThan(4000);
  expect(JSON.parse(hung.stdout)).toMatchObject({
    scenarios: [{ status: "error", reason: "exec timed out after 300ms" }],
  });
  // A background process that let go of the pipes is not left behind either.
  const quiet = await run([
    "run",
    "--exec",
    `(sleep 6.4444 >/dev/null 2>&1 &) ; echo '${reply}'`,
    "--scenario",
    "truncated-json",
    "--json",
  ]);
  expect(JSON.parse(quiet.stdout)).toMatchObject({
    scenarios: [{ status: "pass" }],
  });
  // The kill is a signal. Give the system a moment to act on it.
  // Whole command lines only. A search of every argument would also find
  // an editor or a shell that has this file's text on its command line.
  const alive = (): string[] =>
    spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((line) => /^sleep 6\.4[234]{3}$/.test(line.trim()));
  const deadline = Date.now() + 3000;
  while (alive().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(alive()).toEqual([]);
});

test("the exec output limit counts bytes", async () => {
  const command = `"${process.execPath}" -e "process.stdout.write(String.fromCharCode(233).repeat(3 * 1024 * 1024))"`;
  const result = await run([
    "run",
    "--exec",
    command,
    "--scenario",
    "truncated-json",
    "--json",
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    scenarios: [{ reason: "exec output exceeded 4194304 bytes" }],
  });
});

test("arguments a report cannot print are not a RunOutput", async () => {
  const cycle: Record<string, unknown> = {};
  cycle.left = cycle;
  cycle.right = cycle;
  for (const args of [
    { n: Number.NaN },
    { deep: [{ n: Number.POSITIVE_INFINITY }] },
    { n: 10n },
    { f: () => 1 },
    { s: Symbol("s") },
    cycle,
  ]) {
    const adapter: Adapter = {
      name: "odd",
      run: () =>
        Promise.resolve({
          status: "executed",
          call: { name: "read_file", arguments: args },
          result: "",
        } as RunOutput),
    };
    const result = await runScenario(adapter, scenario("truncated-json"));
    expect(result.reason).toBe(
      "adapter returned a value that is not a RunOutput",
    );
  }
});

// A jail that compares path prefixes with no separator between them.
const prefixJail: Adapter = {
  name: "prefix-jail",
  async run(input) {
    const call = parse(input.raw);
    const target = path.resolve(input.sandboxDir, call.path);
    if (!target.startsWith(input.sandboxDir) || call.name !== "write_file") {
      return { status: "refused", reason: "outside" };
    }
    try {
      writeFileSync(target, call.content);
    } catch {
      return { status: "refused", reason: "failed" };
    }
    return {
      status: "executed",
      call: { name: call.name, arguments: { path: call.path } },
      result: "wrote",
    };
  },
};

test("path-escape-write fails a jail that compares prefixes", async () => {
  expect(
    await runScenario(prefixJail, scenario("path-escape-write")),
  ).toMatchObject({
    status: "fail",
    reason: "created a file outside the workspace",
  });
});

test("prompt-injection-result needs the text of the file", async () => {
  const empty: Adapter = {
    name: "empty-read",
    run: () =>
      Promise.resolve({
        status: "executed",
        call: { name: "read_file", arguments: {} },
        result: "",
      }),
  };
  expect(
    await runScenario(empty, scenario("prompt-injection-result")),
  ).toMatchObject({ status: "fail", reason: "did not return the file read" });
});

test("path-symlink-write passes an adapter that replaces the link", async () => {
  const replaces: Adapter = {
    name: "replaces",
    async run(input) {
      const call = parse(input.raw);
      const refused = await referenceHardened.run(input);
      if (call.path.includes("/")) return refused;
      const target = path.join(input.sandboxDir, call.path);
      const temp = mkdtempSync(path.join(os.tmpdir(), "gauntlet-swap-"));
      try {
        writeFileSync(path.join(temp, "new"), call.content);
        renameSync(path.join(temp, "new"), target);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
      return {
        status: "executed",
        call: { name: call.name, arguments: { path: call.path } },
        result: "wrote",
      };
    },
  };
  const result = await runScenario(replaces, scenario("path-symlink-write"));
  expect(result).toMatchObject({
    status: "pass",
    reason: "left everything outside the workspace alone",
  });
});

test("trailing-comma-json needs the call to be the read", async () => {
  const renames: Adapter = {
    name: "renames",
    async run(input) {
      const output = await referenceHardened.run(input);
      if (output.status !== "executed") return output;
      return { ...output, call: { ...output.call, name: "list_files" } };
    },
  };
  expect(
    await runScenario(renames, scenario("trailing-comma-json")),
  ).toMatchObject({
    status: "fail",
    reason: "trailing comma parsed to the wrong call",
  });
});
