import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { formatSarif } from "../src/sarif.ts";
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

function ids(stdout: string): string[] {
  return (JSON.parse(stdout) as { scenarios: { id: string }[] }).scenarios.map(
    (row) => row.id,
  );
}

// Safe, and unhelpful: it turns down the padded XML call the model meant.
const STRICT_ADAPTER = `
import { referenceHardened } from ${JSON.stringify(path.resolve("dist/index.js"))};
export default {
  name: "strict",
  run(input) {
    if (input.raw.startsWith("<read_file>")) {
      return Promise.resolve({ status: "refused", reason: "padded" });
    }
    return referenceHardened.run(input);
  },
};
`;

test("--tier keeps one tier, and narrows the other filters", async () => {
  const base = ["run", "--adapter", "reference-hardened", "--json"];
  for (const tier of ["safety", "robustness"] as const) {
    const result = await run([...base, "--tier", tier]);
    expect(ids(result.stdout)).toEqual(
      scenarios.filter((item) => item.tier === tier).map((item) => item.id),
    );
  }
  const narrowed = await run([
    ...base,
    "--category",
    "path",
    "--tier",
    "robustness",
  ]);
  expect(ids(narrowed.stdout)).toEqual(["path-unusable"]);
  const unknown = await run([...base, "--tier", "nope"]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toBe("unknown tier nope; one of safety, robustness\n");
  const empty = await run([...base, "--tier", ","]);
  expect(empty.stderr).toBe("missing --tier value\n");
});

test("the report counts each tier on its own line", async () => {
  const full = await run(["run", "--adapter", "reference-naive"]);
  const safety = scenarios.filter((item) => item.tier === "safety").length;
  expect(full.stdout).toContain(
    `5 passed, 23 failed, 0 errors, 0 not covered\nsafety: 1 passed, ${safety - 1} failed, 0 errors, 0 not covered\nrobustness: 4 passed, 3 failed, 0 errors, 0 not covered\n`,
  );
  const one = await run([
    "run",
    "--adapter",
    "reference-naive",
    "--tier",
    "safety",
  ]);
  expect(one.stdout).not.toContain("safety: ");
});

test("list and show name the tier, the layer, and the weakness", async () => {
  const list = await run(["list"]);
  expect(list.stdout).toMatch(/^id +category +tier +summary\n/);
  expect(list.stdout).toMatch(/\npath-escape +path +safety +read_file via/);
  const show = await run(["show", "path-symlink-write"]);
  expect(show.stdout).toContain(
    "category:  path\ntier:      safety\nlayer:     execute\ncwe:       CWE-59\nsummary: ",
  );
  const plain = await run(["show", "trailing-comma-json"]);
  expect(plain.stdout).toContain(
    "tier:      robustness\nlayer:     parse\nsummary: ",
  );
});

test("--fail-on names the tier that decides the exit code", async () => {
  await withDir(async (dir) => {
    const adapter = path.join(dir, "strict.mjs");
    writeFileSync(adapter, STRICT_ADAPTER);
    const base = ["run", "--adapter", adapter];
    const any = await run(base);
    expect(any.code).toBe(1);
    expect(any.stdout).toContain(
      "safety: 21 passed, 0 failed, 0 errors, 0 not covered\nrobustness: 6 passed, 1 failed, 0 errors, 0 not covered\n",
    );
    expect((await run([...base, "--fail-on", "safety"])).code).toBe(0);
    expect((await run([...base, "--fail-on", "robustness"])).code).toBe(1);
    expect((await run([...base, "--fail-on", "any"])).code).toBe(1);
    const bad = await run([...base, "--fail-on", "nope"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe(
      "invalid --fail-on nope; one of any, safety, robustness\n",
    );
  });
});

test("--fail-on applies to a baseline regression too", async () => {
  await withDir(async (dir) => {
    const baseline = path.join(dir, "baseline.json");
    const recorded = await run([
      "run",
      "--adapter",
      "reference-hardened",
      "--update-baseline",
      baseline,
    ]);
    expect(recorded.code).toBe(0);
    const adapter = path.join(dir, "strict.mjs");
    writeFileSync(adapter, STRICT_ADAPTER);
    const base = ["run", "--adapter", adapter, "--baseline", baseline];
    const any = await run(base);
    expect(any.code).toBe(1);
    expect(any.stdout).toContain("regressions:\n  whitespace-padded-args\n");
    const safety = await run([...base, "--fail-on", "safety"]);
    expect(safety.code).toBe(0);
    // The regression is still in the report. It only stopped deciding.
    expect(safety.stdout).toContain("regressions:\n  whitespace-padded-args\n");
  });
});

test("filters that leave nothing to run, or nothing to decide, exit 2", async () => {
  const base = ["run", "--adapter", "reference-naive"];
  const empty = await run([
    ...base,
    "--scenario",
    "path-escape",
    "--tier",
    "robustness",
  ]);
  expect(empty.code).toBe(2);
  expect(empty.stdout).toBe("");
  expect(empty.stderr).toBe(
    "no scenario matches --scenario, --category, and --tier together\n",
  );
  const undecided = await run([
    ...base,
    "--tier",
    "safety",
    "--fail-on",
    "robustness",
  ]);
  expect(undecided.code).toBe(2);
  expect(undecided.stderr).toBe(
    "--fail-on robustness cannot decide a run of --tier safety\n",
  );
  const same = await run([...base, "--tier", "safety", "--fail-on", "safety"]);
  expect(same.code).toBe(1);
});

type Sarif = {
  version: string;
  runs: {
    tool: {
      driver: {
        name: string;
        version: string;
        rules: {
          id: string;
          defaultConfiguration: { level: string };
          properties: { tags: string[] };
        }[];
      };
    };
    automationDetails: { id: string };
    results: {
      ruleId: string;
      ruleIndex: number;
      kind: string;
      level: string;
      message: { text: string };
      locations: { physicalLocation: { artifactLocation: { uri: string } } }[];
    }[];
  }[];
};

function readSarif(file: string): Sarif["runs"][number] {
  const sarif = JSON.parse(readFileSync(file, "utf8")) as Sarif;
  expect(sarif.version).toBe("2.1.0");
  const sarifRun = sarif.runs[0];
  if (!sarifRun) throw new Error("no run");
  return sarifRun;
}

test("--sarif writes a rule per scenario and a result per failure", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "gauntlet.sarif");
    const result = await run([
      "run",
      "--adapter",
      "reference-naive",
      "--name",
      "Agent One (tools)",
      "--sarif",
      file,
      "--sarif-location",
      "src/my agent/tools 100%.ts",
    ]);
    expect(result.code).toBe(1);
    const sarifRun = readSarif(file);
    expect(sarifRun.tool.driver.name).toBe("Gauntlet");
    // The category is what comes before the last slash, one per target.
    expect(sarifRun.automationDetails.id).toBe("gauntlet/agent-one-tools/");
    expect(sarifRun.tool.driver.rules.map((rule) => rule.id)).toEqual(
      scenarios.map((item) => item.id),
    );
    // 23 of the 28 fail. A pass is not a finding.
    expect(sarifRun.results).toHaveLength(23);
    const rule = (id: string) =>
      sarifRun.tool.driver.rules.find((item) => item.id === id);
    const row = (id: string) =>
      sarifRun.results.find((item) => item.ruleId === id);
    expect(rule("path-escape")).toMatchObject({
      defaultConfiguration: { level: "error" },
      properties: { tags: ["safety", "path", "external/cwe/cwe-22"] },
    });
    expect(rule("trailing-comma-json")).toMatchObject({
      defaultConfiguration: { level: "warning" },
      properties: { tags: ["robustness", "json"] },
    });
    expect(row("path-escape")).toMatchObject({
      kind: "fail",
      level: "error",
      message: { text: "dotdot read a file outside the workspace" },
    });
    expect(row("trailing-comma-json")).toMatchObject({
      kind: "fail",
      level: "warning",
    });
    expect(row("deep-nesting")).toBeUndefined();
    for (const item of sarifRun.results) {
      expect(sarifRun.tool.driver.rules[item.ruleIndex]?.id).toBe(item.ruleId);
      // A relative reference with each part encoded.
      expect(item.locations).toEqual([
        {
          physicalLocation: {
            artifactLocation: { uri: "src/my%20agent/tools%20100%25.ts" },
          },
        },
      ]);
    }
  });
});

test("sarif maps an error, leaves out what did not fail, and finds the adapter file", async () => {
  await withDir(async (dir) => {
    const adapter = path.join(dir, "adapter.mjs");
    writeFileSync(
      adapter,
      `export default { name: "odd", run({ aborted }) {
        if (aborted) return { status: "not-covered", reason: "no abort" };
        throw new Error("boom");
      } };\n`,
    );
    const file = path.join(dir, "out.sarif");
    await run([
      "run",
      "--adapter",
      adapter,
      "--scenario",
      "trailing-comma-json,stream-aborted",
      "--sarif",
      file,
    ]);
    const sarifRun = readSarif(file);
    expect(sarifRun.tool.driver.rules).toHaveLength(2);
    expect(sarifRun.results).toMatchObject([
      {
        ruleId: "trailing-comma-json",
        kind: "fail",
        // An adapter that threw is an error whatever the tier.
        level: "error",
        message: { text: "The adapter did not return: boom" },
      },
    ]);
    // The adapter's own path, relative to where the run started and never
    // absolute.
    const uri =
      sarifRun.results[0]?.locations[0]?.physicalLocation.artifactLocation
        .uri ?? "";
    expect(uri.startsWith("/")).toBe(false);
    expect(uri.endsWith("/adapter.mjs")).toBe(true);
    expect(uri).toBe(
      path
        .relative(process.cwd(), adapter)
        .split(path.sep)
        .map(encodeURIComponent)
        .join("/"),
    );
    const clean = await run([
      "run",
      "--adapter",
      "reference-hardened",
      "--sarif",
      file,
      "--sarif-location",
      "src/tools.ts",
    ]);
    expect(clean.code).toBe(0);
    expect(readSarif(file).results).toEqual([]);
  });
});

test("--sarif needs a file to point at", async () => {
  const cases: [string[], string][] = [
    [
      ["--adapter", "reference-naive", "--sarif", "out.sarif"],
      "--sarif needs --sarif-location <path>: the file a viewer opens for a failure\n",
    ],
    [
      ["--exec", "true", "--sarif", "out.sarif"],
      "--sarif needs --sarif-location <path>: the file a viewer opens for a failure\n",
    ],
    [
      ["--adapter", "reference-naive", "--sarif-location", "x.ts"],
      "--sarif-location needs --sarif\n",
    ],
  ];
  for (const [argv, message] of cases) {
    const result = await run(["run", ...argv]);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.stderr).toBe(message);
  }
});

test("formatSarif keeps a failure whose scenario it does not know", () => {
  const text = formatSarif(
    "a",
    "1.2.3",
    [
      {
        id: "future-case",
        title: "x",
        category: "json",
        status: "fail",
        reason: "r",
      },
    ],
    scenarios,
    "a.ts",
  );
  const sarif = JSON.parse(text) as Sarif;
  expect(sarif.runs[0]?.tool.driver.rules).toEqual([]);
  expect(sarif.runs[0]?.results).toMatchObject([
    { ruleId: "future-case", kind: "fail", level: "error" },
  ]);
  expect(sarif.runs[0]?.results[0]).not.toHaveProperty("ruleIndex");
  expect(sarif.runs[0]?.automationDetails.id).toBe("gauntlet/a/");
});

test("--structured with a module adapter hands over the call", async () => {
  await withDir(async (dir) => {
    const adapter = path.join(dir, "structured.mjs");
    writeFileSync(
      adapter,
      `import { referenceHardened } from ${JSON.stringify(path.resolve("dist/index.js"))};
export default {
  name: "call-only",
  run(input) {
    if (input.call === undefined) throw new Error("no call");
    if (Object.keys(input.call.arguments).includes("__proto__") === false &&
        input.raw.includes('"__proto__":')) throw new Error("lost a key");
    return referenceHardened.run(input);
  },
};
`,
    );
    const structured = await run([
      "run",
      "--adapter",
      adapter,
      "--structured",
      "--json",
    ]);
    expect(structured.code).toBe(0);
    const rows = (
      JSON.parse(structured.stdout) as {
        scenarios: { id: string; status: string }[];
      }
    ).scenarios;
    for (const row of rows) {
      const item = scenarios.find((scenario) => scenario.id === row.id);
      expect(row.status, row.id).toBe(
        item?.layer === "execute" ? "pass" : "not-covered",
      );
    }
    const raw = await run([
      "run",
      "--adapter",
      adapter,
      "--scenario",
      "path-escape",
      "--json",
    ]);
    expect(JSON.parse(raw.stdout)).toMatchObject({
      scenarios: [{ status: "error", reason: "no call" }],
    });
  });
});
