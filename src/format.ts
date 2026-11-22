import type { BaselineComparison } from "./baseline.ts";
import { printable } from "./text.ts";
import type { ProbeRecord, Result, Sandbox, Scenario } from "./types.ts";

// JSON.stringify recurses. An adapter that executed the deep-nesting payload
// hands back arguments 10000 arrays deep, and printing them must not be the
// thing that overflows the stack.
const MAX_PRINT_DEPTH = 32;
const RAW_LIMIT = 400;
const RAW_HEAD = 280;
const RAW_TAIL = 80;

type ListRow = {
  id: string;
  title: string;
  category: string;
  tier: string;
  layer: string;
  cwe: readonly string[];
  summary: string;
  expected: string;
};

export function formatList(scenarios: readonly ListRow[]): string {
  const rows = scenarios.map((scenario) => [
    scenario.id,
    scenario.category,
    scenario.tier,
    scenario.summary,
  ]);
  return `${renderTable(rows, ["id", "category", "tier", "summary"])}\n`;
}

export function formatListJson(scenarios: readonly ListRow[]): string {
  const rows = scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    category: scenario.category,
    tier: scenario.tier,
    layer: scenario.layer,
    cwe: scenario.cwe,
    summary: scenario.summary,
    expected: scenario.expected,
  }));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

// Probes that need a path get a placeholder. The real one is a temp directory
// that exists only while the scenario runs.
const PLACEHOLDER_SANDBOX: Sandbox = {
  rootDir: "/sandbox",
  workspaceDir: "/sandbox/workspace",
  outsideFile: "/sandbox/outside.txt",
};

export function formatShow(scenario: Scenario): string {
  const lines = [
    `id:        ${scenario.id}`,
    `title:     ${scenario.title}`,
    `category:  ${scenario.category}`,
    `tier:      ${scenario.tier}`,
    `layer:     ${scenario.layer}`,
    ...(scenario.cwe.length > 0
      ? [`cwe:       ${scenario.cwe.join(", ")}`]
      : []),
    `summary:   ${scenario.summary}`,
    `expected:  ${scenario.expected}`,
  ];
  if (scenario.setup !== undefined) lines.push(`setup:     ${scenario.setup}`);
  if (scenario.aborted) lines.push("aborted:   true");
  lines.push(
    "",
    "The workspace starts with notes.txt. outside.txt sits beside the workspace.",
    "Each probe is the raw string the adapter receives. One with characters that do",
    "not print is shown as a JSON string literal.",
  );
  scenario.probes.forEach((probe, index) => {
    lines.push(
      "",
      `probe ${index + 1}:`,
      showRaw(probe(PLACEHOLDER_SANDBOX), true),
    );
  });
  return `${lines.join("\n")}\n`;
}

// Every scenario that did not pass, with what was sent and what came back.
export function formatDetails(
  results: readonly Result[],
  scenarios: readonly Scenario[],
): string {
  const expected = new Map(
    scenarios.map((scenario) => [scenario.id, scenario.expected]),
  );
  const blocks: string[] = [];
  for (const result of results) {
    if (result.status === "pass") continue;
    const lines = [
      `${result.id}  ${result.status}  ${printable(result.reason)}`,
    ];
    const want = expected.get(result.id);
    if (want !== undefined) lines.push(`  expected: ${want}`);
    (result.probes ?? []).forEach((probe, index) => {
      lines.push(`  probe ${index + 1}:  ${showRaw(probe.raw)}`);
      lines.push(`  output ${index + 1}: ${showOutcome(probe.outcome)}`);
    });
    blocks.push(lines.join("\n"));
  }
  if (blocks.length === 0) return "";
  return `details:\n\n${blocks.join("\n\n")}\n`;
}

export function formatJUnit(
  adapterName: string,
  results: readonly Result[],
): string {
  const totals = count(results);
  const counts = `tests="${results.length}" failures="${totals.fail}" errors="${totals.error}" skipped="${totals.notCovered}"`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="gauntlet" ${counts}>`,
    `  <testsuite name="${xmlText(adapterName)}" ${counts}>`,
  ];
  for (const result of results) {
    const open = `    <testcase classname="gauntlet.${xmlText(result.category)}" name="${xmlText(result.id)}"`;
    if (result.status === "pass") {
      lines.push(`${open}/>`);
      continue;
    }
    const tag =
      result.status === "fail"
        ? "failure"
        : result.status === "error"
          ? "error"
          : "skipped";
    lines.push(
      `${open}>`,
      `      <${tag} message="${xmlText(result.reason)}"/>`,
      "    </testcase>",
    );
  }
  lines.push("  </testsuite>", "</testsuites>");
  return `${lines.join("\n")}\n`;
}

export function formatRun(
  adapterName: string,
  results: readonly Result[],
  baseline?: BaselineComparison,
): string {
  const rows = results.map((result) => [
    result.id,
    result.category,
    result.status,
    printable(result.reason),
  ]);
  const table = renderTable(rows, ["scenario", "category", "status", "reason"]);
  const report = `adapter: ${printable(adapterName)}\n\n${table}\n\n${summaryLine(results)}\n${tierLines(results)}`;
  const extra = formatBaseline(baseline);
  return extra.length === 0 ? report : `${report}\n${extra}`;
}

export function formatJson(
  adapterName: string,
  version: string,
  results: readonly Result[],
  baseline?: BaselineComparison,
  options: { probes?: boolean } = {},
): string {
  const report = {
    adapter: adapterName,
    gauntletVersion: version,
    scenarios: results.map((result) => ({
      id: result.id,
      category: result.category,
      status: result.status,
      reason: result.reason,
      // The four keys above are the stable row. --verbose adds to it.
      ...(options.probes === true
        ? {
            ...(result.tier === undefined ? {} : { tier: result.tier }),
            probes: (result.probes ?? []).map(printableProbe),
          }
        : {}),
    })),
    totals: count(results),
    ...(baseline
      ? {
          baseline: {
            regressions: baseline.regressions,
            improvements: baseline.improvements,
            new: baseline.added,
          },
        }
      : {}),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

function formatBaseline(baseline: BaselineComparison | undefined): string {
  if (!baseline) return "";
  const lines: string[] = [];
  appendGroup(lines, "regressions", baseline.regressions);
  appendGroup(lines, "improvements", baseline.improvements);
  appendGroup(lines, "new", baseline.added);
  if (baseline.improvements.length > 0) {
    lines.push("rerun with --update-baseline to record improvements");
  }
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

function appendGroup(
  lines: string[],
  label: string,
  ids: readonly string[],
): void {
  if (ids.length === 0) return;
  lines.push(`${label}:`);
  for (const id of ids) lines.push(`  ${id}`);
}

// One line per tier, when the run has scenarios of both. A reader who gates
// on safety sees that count without adding up rows.
function tierLines(results: readonly Result[]): string {
  const lines: string[] = [];
  for (const tier of ["safety", "robustness"] as const) {
    const rows = results.filter((result) => result.tier === tier);
    if (rows.length === 0 || rows.length === results.length) return "";
    lines.push(`${tier}: ${summaryLine(rows)}`);
  }
  return lines.length === 2 ? `${lines.join("\n")}\n` : "";
}

function summaryLine(results: readonly Result[]): string {
  const totals = count(results);
  return `${totals.pass} passed, ${totals.fail} failed, ${totals.error} errors, ${totals.notCovered} not covered`;
}

function count(results: readonly Result[]): {
  pass: number;
  fail: number;
  error: number;
  notCovered: number;
} {
  let pass = 0;
  let fail = 0;
  let error = 0;
  let notCovered = 0;
  for (const result of results) {
    if (result.status === "pass") pass += 1;
    else if (result.status === "fail") fail += 1;
    else if (result.status === "not-covered") notCovered += 1;
    else error += 1;
  }
  return { pass, fail, error, notCovered };
}

function renderTable(
  rows: readonly (readonly string[])[],
  headers: readonly string[],
): string {
  const widths = headers.map((header, index) => {
    let width = header.length;
    for (const row of rows) {
      const cell = row[index] ?? "";
      if (cell.length > width) width = cell.length;
    }
    return width;
  });
  const render = (row: readonly string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [render(headers), ...rows.map((row) => render(row))].join("\n");
}

// A refusal from an MCP server keeps its whole text, which can be megabytes.
// A report prints the start of it.
const MAX_REASON_CHARS = 4096;

function printableProbe(probe: ProbeRecord): ProbeRecord {
  const outcome = probe.outcome;
  if (outcome.status !== "executed") {
    if (outcome.reason.length <= MAX_REASON_CHARS) return probe;
    return {
      raw: probe.raw,
      outcome: {
        ...outcome,
        reason: outcome.reason.slice(0, MAX_REASON_CHARS),
      },
    };
  }
  return {
    raw: probe.raw,
    outcome: {
      status: "executed",
      call: {
        name: outcome.call.name,
        arguments: clampRecord(outcome.call.arguments, MAX_PRINT_DEPTH),
      },
      result: outcome.result,
    },
  };
}

function clampRecord(
  record: Record<string, unknown>,
  levels: number,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      clampDepth(entry, levels - 1),
    ]),
  );
}

function clampDepth(value: unknown, levels: number): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (levels <= 0) return "[nested too deep to print]";
  if (Array.isArray(value)) {
    return value.map((item) => clampDepth(item, levels - 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      clampDepth(entry, levels - 1),
    ]),
  );
}

function showOutcome(outcome: ProbeRecord["outcome"]): string {
  if (outcome.status === "executed") {
    const args = showRaw(
      JSON.stringify(clampDepth(outcome.call.arguments, MAX_PRINT_DEPTH)),
    );
    return `executed ${printable(outcome.call.name)} ${args} => ${showRaw(outcome.result)}`;
  }
  // A refusal can carry a whole file. One line of it is enough here.
  const reason = printable(outcome.reason.split(/\r\n|\r|\n/)[0] ?? "");
  return `${outcome.status}: ${reason.length <= RAW_LIMIT ? reason : `${reason.slice(0, RAW_HEAD)} ...`}`;
}

// Printable ASCII is shown as it is. Anything else becomes a JSON string
// literal with every invisible character escaped, so the reader sees which
// bytes were sent. A long payload is cut in the middle.
function showRaw(raw: string, multiline = false): string {
  const plain = multiline ? /^[\x20-\x7e\n]*$/ : /^[\x20-\x7e]*$/;
  const text = plain.test(raw) ? raw : printable(JSON.stringify(raw));
  if (text.length <= RAW_LIMIT) return text;
  const bytes = Buffer.byteLength(raw);
  return `${text.slice(0, RAW_HEAD)} ... ${text.slice(-RAW_TAIL)} (${bytes} bytes)`;
}

function xmlText(value: string): string {
  return value
    .replace(/[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "?")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
