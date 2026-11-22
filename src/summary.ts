import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

type ScenarioRow = {
  id: string;
  category: string;
  status: string;
  reason: string;
};

type Totals = {
  pass: number;
  fail: number;
  error: number;
  notCovered: number;
};

type BaselineSection = {
  regressions: string[];
  improvements: string[];
  new: string[];
};

type Report = {
  adapter: string;
  gauntletVersion: string;
  scenarios: ScenarioRow[];
  totals: Totals;
  baseline?: BaselineSection;
};

export function formatMarkdownSummary(json: unknown): string {
  const report = parseReport(json);
  const lines = [
    "## Gauntlet",
    "",
    `adapter: ${codeSpan(report.adapter)}`,
    `gauntlet: ${codeSpan(report.gauntletVersion)}`,
    "",
    "| scenario | category | status | reason |",
    "| --- | --- | --- | --- |",
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${cell(scenario.id)} | ${cell(scenario.category)} | ${cell(scenario.status)} | ${cell(scenario.reason)} |`,
    );
  }
  lines.push("", countLine(report.totals));
  if (report.baseline !== undefined) {
    lines.push("", formatBaselineSection(report.baseline));
  }
  return `${lines.join("\n")}\n`;
}

export function formatActionOutputs(json: unknown): string {
  const report = parseReport(json);
  const regressions = report.baseline?.regressions.join(",") ?? "";
  const lines = [
    `pass=${report.totals.pass}`,
    `fail=${report.totals.fail}`,
    `error=${report.totals.error}`,
    `not-covered=${report.totals.notCovered}`,
    `regressions=${regressions}`,
  ];
  return `${lines.join("\n")}\n`;
}

function formatBaselineSection(baseline: BaselineSection): string {
  const lines = [
    "### Baseline",
    "",
    formatGroup("regressions", baseline.regressions),
    "",
    formatGroup("improvements", baseline.improvements),
    "",
    formatGroup("new", baseline.new),
  ];
  if (baseline.improvements.length > 0) {
    lines.push("", "rerun with --update-baseline to record improvements");
  }
  return lines.join("\n");
}

function formatGroup(label: string, ids: readonly string[]): string {
  if (ids.length === 0) return `${label}: none`;
  const items = ids.map((id) => `- ${codeSpan(id)}`);
  return `${label}:\n\n${items.join("\n")}`;
}

function countLine(totals: Totals): string {
  return `${totals.pass} passed, ${totals.fail} failed, ${totals.error} errors, ${totals.notCovered} not covered`;
}

function codeSpan(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function cell(value: string): string {
  return (
    value
      .replaceAll("\r\n", " ")
      .replaceAll("\n", " ")
      .replaceAll("\r", " ")
      // Backslash first. One already in the text would otherwise pair with
      // the next character's own escape and leave that character active.
      .replaceAll("\\", "\\\\")
      .replaceAll("|", "\\|")
      .replaceAll("`", "'")
      .replaceAll("_", "\\_")
      .replaceAll("*", "\\*")
  );
}

function parseReport(json: unknown): Report {
  const value = typeof json === "string" ? parseJsonText(json) : json;
  if (!isRecord(value)) throw new Error("report was not an object");
  const adapter = readString(value, "adapter");
  const gauntletVersion = readString(value, "gauntletVersion");
  if (!("scenarios" in value) || !Array.isArray(value.scenarios)) {
    throw new Error("report missing scenarios");
  }
  const scenarios: ScenarioRow[] = [];
  for (const row of value.scenarios) scenarios.push(parseScenario(row));
  if (!("totals" in value)) throw new Error("report missing totals");
  const totals = parseTotals(value.totals);
  const report: Report = { adapter, gauntletVersion, scenarios, totals };
  if ("baseline" in value && value.baseline !== undefined) {
    report.baseline = parseBaseline(value.baseline);
  }
  return report;
}

function parseJsonText(text: string): unknown {
  if (text.trim().length === 0) throw new Error("report was empty");
  return JSON.parse(text);
}

function parseScenario(value: unknown): ScenarioRow {
  if (!isRecord(value)) throw new Error("scenario was not an object");
  return {
    id: readString(value, "id"),
    category: readString(value, "category"),
    status: readString(value, "status"),
    reason: readString(value, "reason"),
  };
}

function parseTotals(value: unknown): Totals {
  if (!isRecord(value)) throw new Error("totals was not an object");
  return {
    pass: readCount(value, "pass"),
    fail: readCount(value, "fail"),
    error: readCount(value, "error"),
    notCovered: readCount(value, "notCovered"),
  };
}

function parseBaseline(value: unknown): BaselineSection {
  if (!isRecord(value)) throw new Error("baseline was not an object");
  return {
    regressions: readIds(value, "regressions"),
    improvements: readIds(value, "improvements"),
    new: readIds(value, "new"),
  };
}

function readString(value: Record<string, unknown>, key: string): string {
  if (!(key in value)) throw new Error(`report missing ${key}`);
  const field = value[key];
  if (typeof field !== "string")
    throw new Error(`report ${key} was not a string`);
  return field;
}

function readCount(value: Record<string, unknown>, key: string): number {
  if (!(key in value)) throw new Error(`totals missing ${key}`);
  const field = value[key];
  if (typeof field !== "number" || !Number.isInteger(field)) {
    throw new Error(`totals ${key} was not an integer`);
  }
  return field;
}

function readIds(value: Record<string, unknown>, key: string): string[] {
  if (!(key in value)) throw new Error(`baseline missing ${key}`);
  const field = value[key];
  if (!Array.isArray(field)) {
    throw new Error(`baseline ${key} was not a list of strings`);
  }
  const ids: string[] = [];
  for (const item of field) {
    if (typeof item !== "string") {
      throw new Error(`baseline ${key} was not a list of strings`);
    }
    ids.push(item);
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRunFailure(
  exitCode: string,
  stderr: string,
  error: unknown,
): string {
  const code = exitCode.length > 0 ? exitCode : "unknown";
  const lines = [
    "## Gauntlet",
    "",
    `Gauntlet exited ${code} before writing a report.`,
  ];
  const detail = stderr.trim();
  if (detail.length > 0) {
    lines.push("", "```", detail, "```");
  } else if (error instanceof Error && error.message.length > 0) {
    lines.push("", error.message);
  }
  return `${lines.join("\n")}\n`;
}

function writeEnvFile(
  name: "GITHUB_STEP_SUMMARY" | "GITHUB_OUTPUT",
  text: string,
): void {
  const file = process.env[name];
  if (file === undefined || file.length === 0) return;
  appendFileSync(file, text);
}

function readStderr(): string {
  const file = process.env.GAUNTLET_STDERR_PATH;
  if (file === undefined || file.length === 0) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    const jsonPath = process.env.GAUNTLET_JSON_PATH;
    if (jsonPath === undefined || jsonPath.length === 0) {
      throw new Error("GAUNTLET_JSON_PATH is not set");
    }
    const raw = readFileSync(jsonPath, "utf8");
    writeEnvFile("GITHUB_STEP_SUMMARY", formatMarkdownSummary(raw));
    writeEnvFile("GITHUB_OUTPUT", formatActionOutputs(raw));
  } catch (error) {
    writeEnvFile(
      "GITHUB_STEP_SUMMARY",
      formatRunFailure(
        process.env.GAUNTLET_EXIT_CODE ?? "",
        readStderr(),
        error,
      ),
    );
  }
}
