import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { scenarios } from "../src/scenarios/index.ts";

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

async function withDir(use: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-test-"));
  try {
    await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rowIds(stdout: string): string[] {
  const report = JSON.parse(stdout) as { scenarios: { id: string }[] };
  return report.scenarios.map((row) => row.id);
}

test("help and version exit 0 and write to stdout", async () => {
  for (const argv of [["help"], ["--help"], ["-h"], ["run", "--help"]]) {
    const result = await run(argv);
    expect(result.code, argv.join(" ")).toBe(0);
    expect(result.stdout).toContain("gauntlet run <target>");
    expect(result.stdout).toContain("exit codes:");
    expect(result.stderr).toBe("");
  }
  const version = await run(["--version"]);
  expect(version.code).toBe(0);
  expect(version.stdout).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?\n$/);
  const none = await run([]);
  expect(none.code).toBe(2);
  expect(none.stderr).toMatch(/^usage: gauntlet /);
});

test("list --json prints one row per scenario", async () => {
  const result = await run(["list", "--json"]);
  expect(result.code).toBe(0);
  const rows = JSON.parse(result.stdout) as Record<string, string>[];
  expect(rows.map((row) => row.id)).toEqual(scenarios.map((item) => item.id));
  for (const row of rows) {
    expect(Object.keys(row)).toEqual([
      "id",
      "title",
      "category",
      "summary",
      "expected",
    ]);
  }
  const bad = await run(["list", "--nope"]);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toBe("unknown argument --nope\n");
});

test("show prints the payloads a scenario sends", async () => {
  const result = await run(["show", "path-symlink-write"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("id:        path-symlink-write");
  expect(result.stdout).toContain("expected:  Refuses each write, or");
  expect(result.stdout).toContain("setup:     alias links to outside.txt");
  expect(result.stdout).toContain("probe 3:");
  expect(result.stdout).toContain(
    'probe 3:\n{"name":"write_file","arguments":{"path":"updir/dropped.txt","content":"x"}}\n',
  );
  const xml = await run(["show", "whitespace-padded-args"]);
  expect(xml.stdout).toContain(
    "probe 1:\n<read_file>\n<path> notes.txt </path>\n",
  );
  const aborted = await run(["show", "stream-aborted"]);
  expect(aborted.stdout).toContain("aborted:   true");
  const absolute = await run(["show", "path-escape"]);
  expect(absolute.stdout).toContain("/sandbox/outside.txt");
});

test("show escapes invisible characters and cuts long payloads", async () => {
  const bidi = await run(["show", "unicode-bidi-path"]);
  expect(bidi.stdout).toContain("notes\\u202etxt.sh");
  expect(bidi.stdout).not.toContain("\u202e");
  const nul = await run(["show", "path-nul-byte"]);
  expect(nul.stdout).toContain("notes.txt\\u0000.md");
  const big = await run(["show", "oversized-argument"]);
  expect(big.stdout).toMatch(/ \.\.\. .*\(\d+ bytes\)\n$/);
  expect(big.stdout.length).toBeLessThan(2000);
  for (const item of scenarios) {
    const shown = await run(["show", item.id]);
    expect(shown.code, item.id).toBe(0);
    expect(shown.stdout.length, item.id).toBeLessThan(6000);
  }
});

test("show needs one known id", async () => {
  const missing = await run(["show"]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toBe("usage: gauntlet show <id>\n");
  const unknown = await run(["show", "nope"]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toBe("unknown scenario nope\n");
});

test("scenario and category filters add up and keep report order", async () => {
  const base = ["run", "--adapter", "reference-hardened", "--json"];
  const two = await run([...base, "--scenario", "path-symlink,truncated-json"]);
  expect(rowIds(two.stdout)).toEqual(["truncated-json", "path-symlink"]);
  const repeated = await run([
    ...base,
    "--scenario",
    "path-symlink",
    "--scenario",
    "truncated-json",
  ]);
  expect(rowIds(repeated.stdout)).toEqual(rowIds(two.stdout));
  const category = await run([...base, "--category", "xml,unicode"]);
  expect(rowIds(category.stdout)).toEqual(
    scenarios
      .filter((item) => item.category === "xml" || item.category === "unicode")
      .map((item) => item.id),
  );
  const both = await run([
    ...base,
    "--category",
    "stream",
    "--scenario",
    "truncated-json",
  ]);
  expect(rowIds(both.stdout)).toEqual(["truncated-json", "stream-aborted"]);
});

test("an unknown scenario or category exits 2", async () => {
  const base = ["run", "--adapter", "reference-hardened"];
  const scenario = await run([...base, "--scenario", "truncated-json,nope"]);
  expect(scenario.code).toBe(2);
  expect(scenario.stderr).toBe("unknown scenario nope\n");
  const category = await run([...base, "--category", "nope"]);
  expect(category.code).toBe(2);
  expect(category.stderr).toMatch(
    /^unknown category nope; one of whitespace, /,
  );
});

test("verbose adds what was sent and what came back for a failure", async () => {
  const result = await run([
    "run",
    "--adapter",
    "reference-naive",
    "--scenario",
    "truncated-json,trailing-comma-in-string",
    "--verbose",
  ]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain(
    [
      "details:",
      "",
      "truncated-json  fail  executed a truncated tool call",
      "  expected: Refuses the call.",
      '  probe 1:  {"name":"read_file","arguments":{"path":"notes.txt"',
      '  output 1: executed read_file {"path":"notes.txt"} => "hello\\n"',
      "",
    ].join("\n"),
  );
  expect(result.stdout).not.toContain("trailing-comma-in-string  pass");
  const clean = await run([
    "run",
    "--adapter",
    "reference-hardened",
    "--scenario",
    "truncated-json",
    "--verbose",
  ]);
  expect(clean.code).toBe(0);
  expect(clean.stdout).not.toContain("details:");
});

test("verbose json adds probes to each scenario", async () => {
  const result = await run([
    "run",
    "--adapter",
    "reference-hardened",
    "--scenario",
    "truncated-json",
    "--json",
    "--verbose",
  ]);
  const report = JSON.parse(result.stdout) as {
    scenarios: { probes: unknown }[];
  };
  expect(report.scenarios[0]?.probes).toEqual([
    {
      raw: '{"name":"read_file","arguments":{"path":"notes.txt"',
      outcome: { status: "refused", reason: "truncated or invalid JSON" },
    },
  ]);
});

test("verbose prints arguments nested deeper than the stack allows", async () => {
  const base = ["run", "--adapter", "reference-naive", "--verbose"];
  const json = await run([...base, "--json", "--scenario", "deep-nesting"]);
  expect(json.code).toBe(0);
  expect(json.stdout).toContain("[nested too deep to print]");
  const report = JSON.parse(json.stdout) as { scenarios: { id: string }[] };
  expect(report.scenarios).toMatchObject([{ id: "deep-nesting" }]);
  // A check that fails on an executed deep call goes through the text path.
  const { formatDetails } = await import("../src/format.ts");
  const { runScenario } = await import("../src/run.ts");
  const { referenceNaive } = await import("../src/adapters/reference.ts");
  const deep = scenarios.find((item) => item.id === "deep-nesting");
  if (!deep) throw new Error("missing deep-nesting");
  const result = await runScenario(referenceNaive, deep);
  const text = formatDetails([{ ...result, status: "fail" }], scenarios);
  expect(text).toContain("[nested too deep to print]");
});

test("a report larger than a pipe buffer arrives whole", () => {
  const child = spawnSync(
    process.execPath,
    [
      "dist/cli.js",
      "run",
      "--adapter",
      "reference-naive",
      "--json",
      "--verbose",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  expect(child.status).toBe(1);
  expect(child.stdout.length).toBeGreaterThan(100_000);
  const report = JSON.parse(child.stdout) as { scenarios: unknown[] };
  expect(report.scenarios).toHaveLength(scenarios.length);
});

test("junit writes one testcase per scenario", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "gauntlet.xml");
    const result = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--junit",
      file,
    ]);
    expect(result.code).toBe(1);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain(
      `<testsuite name="reference-naive" tests="${scenarios.length}" failures="23" errors="0" skipped="0">`,
    );
    expect(xml.match(/<testcase /g)).toHaveLength(scenarios.length);
    expect(xml).toContain(
      '<testcase classname="gauntlet.json" name="truncated-json">\n      <failure message="executed a truncated tool call"/>',
    );
    expect(xml).toContain(
      '<testcase classname="gauntlet.size" name="deep-nesting"/>',
    );
  });
});

test("junit escapes markup and maps error and not-covered", async () => {
  await withDir(async (dir) => {
    const adapter = path.join(dir, "adapter.mjs");
    writeFileSync(
      adapter,
      `export default { name: "a<b>&\\"c", run({ aborted }) {
        if (aborted) return { status: "not-covered", reason: "no <abort> & such" };
        throw new Error("bad \\u0001 <tag>");
      } };\n`,
    );
    const file = path.join(dir, "out.xml");
    const result = await run([
      "run",
      "--adapter",
      adapter,
      "--scenario",
      "truncated-json,stream-aborted",
      "--junit",
      file,
    ]);
    expect(result.code).toBe(1);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain('<testsuite name="a&lt;b&gt;&amp;&quot;c" ');
    expect(xml).toContain('<error message="bad ? &lt;tag&gt;"/>');
    expect(xml).toContain('<skipped message="no &lt;abort&gt; &amp; such"/>');
    const unwritable = await run([
      "run",
      "--adapter",
      "reference-hardened",
      "--junit",
      path.join(dir, "missing", "out.xml"),
    ]);
    expect(unwritable.code).toBe(2);
    expect(unwritable.stderr).toMatch(/^could not write .*out\.xml: /);
  });
});

test("timeout applies to a module adapter", async () => {
  await withDir(async (dir) => {
    const adapter = path.join(dir, "hung.mjs");
    writeFileSync(
      adapter,
      'export default { name: "hung", run: () => new Promise(() => {}) };\n',
    );
    const result = await run([
      "run",
      "--adapter",
      adapter,
      "--scenario",
      "truncated-json",
      "--timeout",
      "40",
      "--json",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      scenarios: { status: string; reason: string }[];
    };
    expect(report.scenarios).toMatchObject([
      { status: "error", reason: "adapter timed out after 40ms" },
    ]);
  });
});

test("exec output past the limit is an error", async () => {
  const command = `"${process.execPath}" -e "process.stdout.write('x'.repeat(5 * 1024 * 1024))"`;
  const result = await run([
    "run",
    "--exec",
    command,
    "--scenario",
    "truncated-json",
    "--json",
  ]);
  expect(result.code).toBe(1);
  const report = JSON.parse(result.stdout) as {
    scenarios: { status: string; reason: string }[];
  };
  expect(report.scenarios).toMatchObject([
    { status: "error", reason: "exec output exceeded 4194304 bytes" },
  ]);
});

test("the README names every scenario", () => {
  const readme = readFileSync("README.md", "utf8");
  for (const item of scenarios) {
    expect(readme, item.id).toContain(`| ${item.id} `);
  }
});

test("the built package entry runs the suite from code", async () => {
  // The path is computed so the typecheck does not need dist to exist.
  const entry = pathToFileURL(path.resolve("dist", "index.js")).href;
  const api = (await import(entry)) as typeof import("../src/index.ts");
  expect(Object.keys(api).sort()).toEqual([
    "FIXTURE_NOTE",
    "FIXTURE_SECRET",
    "adapters",
    "asRunOutput",
    "defineAdapter",
    "referenceHardened",
    "referenceNaive",
    "runAll",
    "runScenario",
    "scenarios",
  ]);
  const results = await api.runAll(api.referenceHardened, api.scenarios, {
    timeoutMs: 10_000,
  });
  expect(results.map((result) => result.id)).toEqual(
    scenarios.map((item) => item.id),
  );
  expect(results.every((result) => result.status === "pass")).toBe(true);
  expect(api.asRunOutput({ status: "refused", reason: "no" })).toEqual({
    status: "refused",
    reason: "no",
  });
  expect(api.asRunOutput({ status: "refused" })).toBeUndefined();
});
