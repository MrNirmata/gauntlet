import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { scenarios } from "../src/scenarios/index.ts";

const script = path.resolve("scripts/action-run.sh");
const execNaive = path.resolve("test/fixtures/exec-naive.mjs");

test("reference-naive without a baseline fails the step", () => {
  const result = runAction({ INPUT_ADAPTER: "reference-naive" });
  expect(result.code).toBe(1);
  expect(result.outputs.get("pass")).toBe("4");
  expect(result.outputs.get("fail")).toBe("20");
  expect(result.outputs.get("error")).toBe("0");
  expect(result.outputs.get("not-covered")).toBe("0");
  expect(result.outputs.get("regressions")).toBe("");
  expect(counted(result.outputs)).toBe(scenarios.length);
  expect(result.summary).toContain("| scenario | category | status | reason |");
  expect(result.summary).toContain(
    "4 passed, 20 failed, 0 errors, 0 not covered",
  );
  expect(result.summary).not.toContain("### Baseline");
  for (const scenario of scenarios) {
    expect(result.summary).toContain(scenario.id);
  }
});

test("reference-naive with a matching baseline passes", async () => {
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
    const result = runAction(
      { INPUT_ADAPTER: "reference-naive", INPUT_BASELINE: "baseline.json" },
      dir,
    );
    expect(result.code).toBe(0);
    expect(result.outputs.get("pass")).toBe("4");
    expect(result.outputs.get("fail")).toBe("20");
    expect(result.outputs.get("regressions")).toBe("");
    expect(result.summary).toContain("### Baseline");
    expect(result.summary).toContain("regressions: none");
    expect(result.summary).toContain("improvements: none");
    expect(result.summary).toContain("new: none");
    expect(result.stderr).toBe("");
  });
});

test("a baseline regression is an output and fails the step", () => {
  withDirSync((dir) => {
    writeFileSync(
      path.join(dir, "baseline.json"),
      baselineFile({ "truncated-json": "pass" }),
    );
    const result = runAction(
      {
        INPUT_ADAPTER: "reference-naive",
        INPUT_SCENARIO: "truncated-json",
        INPUT_BASELINE: "baseline.json",
      },
      dir,
    );
    expect(result.code).toBe(1);
    expect(result.outputs.get("fail")).toBe("1");
    expect(result.outputs.get("regressions")).toBe("truncated-json");
    expect(result.summary).toContain("regressions:\n\n- `truncated-json`");
  });
});

test("strict is passed only when the input is true", () => {
  withDirSync((dir) => {
    writeFileSync(path.join(dir, "baseline.json"), baselineFile({}));
    const loose = runAction(
      {
        INPUT_ADAPTER: "reference-naive",
        INPUT_SCENARIO: "truncated-json",
        INPUT_BASELINE: "baseline.json",
        INPUT_STRICT: "false",
      },
      dir,
    );
    expect(loose.code).toBe(0);
    expect(loose.outputs.get("regressions")).toBe("");
    expect(loose.summary).toContain("new:\n\n- `truncated-json`");
    expect(loose.stderr).toContain(
      "warning: new scenario truncated-json is fail",
    );

    const strict = runAction(
      {
        INPUT_ADAPTER: "reference-naive",
        INPUT_SCENARIO: "truncated-json",
        INPUT_BASELINE: "baseline.json",
        INPUT_STRICT: "true",
      },
      dir,
    );
    expect(strict.code).toBe(1);
    expect(strict.outputs.get("regressions")).toBe("truncated-json");
    expect(strict.summary).toContain("regressions:\n\n- `truncated-json`");
  });
});

test("exec is one argument", () => {
  const result = runAction({
    INPUT_EXEC: `node ${execNaive}`,
    INPUT_SCENARIO: "truncated-json",
  });
  expect(result.code).toBe(1);
  expect(result.outputs.get("fail")).toBe("1");
  expect(result.outputs.get("pass")).toBe("0");
  expect(result.summary).toContain(`adapter: \`exec:node ${execNaive}\``);
  expect(result.summary).toContain("| truncated-json | json | fail |");
});

test("shell metacharacters in an input are not executed", () => {
  withDirSync((dir) => {
    const marker = path.join(dir, "pwned");
    const adapter = `reference-naive; touch ${marker}`;
    const result = runAction({ INPUT_ADAPTER: adapter }, dir);
    expect(existsSync(marker)).toBe(false);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`unknown adapter ${adapter}`);
    expect(result.summary).toContain(
      "Gauntlet exited 2 before writing a report.",
    );
    expect(result.summary).toContain(adapter);
    expect(result.outputs.size).toBe(0);
  });
});

test("a name with command substitution is a label", () => {
  withDirSync((dir) => {
    const marker = path.join(dir, "pwned");
    const name = `$(touch ${marker})`;
    const result = runAction(
      {
        INPUT_ADAPTER: "reference-naive",
        INPUT_SCENARIO: "trailing-comma-in-string",
        INPUT_NAME: name,
      },
      dir,
    );
    expect(existsSync(marker)).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(name);
    expect(result.summary).toContain(codeSpan(name));
    expect(result.outputs.get("pass")).toBe("1");
  });
});

test("adapter and http together exit 2", () => {
  const result = runAction({
    INPUT_ADAPTER: "reference-naive",
    INPUT_HTTP: "http://127.0.0.1:9",
    INPUT_SCENARIO: "truncated-json",
  });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(
    "--adapter, --exec, and --http are mutually exclusive",
  );
  expect(result.summary).toContain("exited 2");
  expect(result.outputs.size).toBe(0);
});

test("an invalid timeout is passed through to gauntlet", () => {
  const result = runAction({
    INPUT_ADAPTER: "reference-naive",
    INPUT_TIMEOUT: "0",
  });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("invalid --timeout");
});

function counted(outputs: Map<string, string>): number {
  const keys = ["pass", "fail", "error", "not-covered"] as const;
  let total = 0;
  for (const key of keys) total += Number(outputs.get(key));
  return total;
}

function codeSpan(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function baselineFile(scenarioStatuses: Record<string, string>): string {
  return `${JSON.stringify({
    gauntletVersion: "9.9.9",
    adapter: "reference-naive",
    scenarios: scenarioStatuses,
  })}\n`;
}

type ActionResult = {
  code: number;
  stdout: string;
  stderr: string;
  summary: string;
  outputs: Map<string, string>;
};

function runAction(
  inputs: Record<string, string>,
  cwd = process.cwd(),
): ActionResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-action-"));
  const summary = path.join(dir, "summary.md");
  const output = path.join(dir, "output.txt");
  try {
    const result = spawnSync("bash", [script], {
      cwd,
      env: actionEnv(inputs, summary, output),
      encoding: "utf8",
    });
    const summaryText = existsSync(summary)
      ? readFileSync(summary, "utf8")
      : "";
    const outputText = existsSync(output) ? readFileSync(output, "utf8") : "";
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      summary: summaryText,
      outputs: readOutputs(outputText),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function actionEnv(
  inputs: Record<string, string>,
  summary: string,
  output: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    GITHUB_ACTION_PATH: path.resolve("."),
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_OUTPUT: output,
  };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR;
  for (const [key, value] of Object.entries(inputs)) env[key] = value;
  return env;
}

function readOutputs(text: string): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const index = line.indexOf("=");
    if (index === -1) throw new Error(`bad output line ${line}`);
    outputs.set(line.slice(0, index), line.slice(index + 1));
  }
  return outputs;
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

function withDirSync(check: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-action-work-"));
  try {
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withDir(check: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-action-work-"));
  try {
    await check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
