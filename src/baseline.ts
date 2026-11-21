import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Result } from "./types.ts";

type Status = Result["status"];

export type BaselineData = {
  gauntletVersion: string;
  adapter: string;
  scenarios: Record<string, Status>;
};

export type BaselineComparison = {
  regressions: string[];
  improvements: string[];
  added: string[];
  removed: string[];
};

export function readBaseline(file: string): BaselineData | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path.resolve(process.cwd(), file), "utf8");
  } catch (error) {
    if (isNotFound(error)) return { error: `baseline file not found: ${file}` };
    return { error: `could not read baseline ${file}: ${firstLine(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `invalid baseline ${file}: ${firstLine(error)}` };
  }
  const baseline = parseBaseline(parsed);
  if ("error" in baseline) {
    return { error: `invalid baseline ${file}: ${baseline.error}` };
  }
  return baseline;
}

export function writeBaseline(
  file: string,
  version: string,
  adapterName: string,
  results: readonly Result[],
): string | undefined {
  const scenarios: Record<string, Status> = {};
  const ordered = [...results].sort((left, right) =>
    compareIds(left.id, right.id),
  );
  for (const result of ordered) scenarios[result.id] = result.status;
  const text = `${JSON.stringify(
    { gauntletVersion: version, adapter: adapterName, scenarios },
    null,
    2,
  )}\n`;
  try {
    writeFileSync(path.resolve(process.cwd(), file), text, "utf8");
  } catch (error) {
    return `could not write baseline ${file}: ${firstLine(error)}`;
  }
  return undefined;
}

export function compareBaseline(
  baseline: BaselineData,
  results: readonly Result[],
  knownIds: readonly string[],
  strict: boolean,
): BaselineComparison {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const added: string[] = [];
  const known = new Set(knownIds);
  for (const result of results) {
    const previous = baseline.scenarios[result.id];
    if (previous === undefined) {
      added.push(result.id);
      if (strict && (result.status === "fail" || result.status === "error")) {
        regressions.push(result.id);
      }
      continue;
    }
    if (regressed(previous, result.status)) {
      regressions.push(result.id);
      continue;
    }
    if (improved(previous, result.status)) improvements.push(result.id);
  }
  const removed = Object.keys(baseline.scenarios)
    .filter((id) => !known.has(id))
    .sort(compareIds);
  return { regressions, improvements, added, removed };
}

function regressed(previous: Status, current: Status): boolean {
  const wasOk = previous === "pass" || previous === "not-covered";
  const isBad = current === "fail" || current === "error";
  return wasOk && isBad;
}

function improved(previous: Status, current: Status): boolean {
  const wasBad = previous === "fail" || previous === "error";
  return wasBad && current === "pass";
}

function parseBaseline(value: unknown): BaselineData | { error: string } {
  if (!isRecord(value)) return { error: "expected an object" };
  const version = readString(value, "gauntletVersion");
  if (typeof version !== "string") return version;
  const adapter = readString(value, "adapter");
  if (typeof adapter !== "string") return adapter;
  if (!("scenarios" in value)) return { error: "missing scenarios" };
  const scenarios = value.scenarios;
  if (!isRecord(scenarios)) return { error: "scenarios must be an object" };
  const statuses: Record<string, Status> = {};
  for (const [id, status] of Object.entries(scenarios)) {
    if (!isStatus(status)) {
      return { error: `scenario ${id} has an invalid status` };
    }
    statuses[id] = status;
  }
  return { gauntletVersion: version, adapter, scenarios: statuses };
}

function readString(
  value: Record<string, unknown>,
  key: "gauntletVersion" | "adapter",
): string | { error: string } {
  if (!(key in value)) return { error: `missing ${key}` };
  const field = value[key];
  if (typeof field !== "string") return { error: `${key} must be a string` };
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is Status {
  return (
    value === "pass" ||
    value === "fail" ||
    value === "error" ||
    value === "not-covered"
  );
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n")[0];
  return line !== undefined && line.length > 0 ? line : "unknown error";
}
