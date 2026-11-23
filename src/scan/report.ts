import { printable, printableJson } from "../text.ts";
import {
  type Finding,
  type FindingKind,
  type FindingTier,
  HELD,
  type ScanReport,
  WRITES,
} from "./scan.ts";

// What to change, one line for each kind of finding.
const FIX: Readonly<Record<FindingKind, string>> = {
  "outside-read":
    "Resolve the path against the allowed directory, follow symlinks, and refuse a result outside it.",
  "outside-list":
    "Resolve the path against the allowed directory, follow symlinks, and refuse a result outside it.",
  "outside-write":
    "Resolve the path and its symlinks before writing, and refuse a target outside the allowed directory.",
  "url-file-read":
    "Allow http and https only. Refuse file: and every other scheme.",
  "shell-injection":
    "Do not build a shell command from an argument. Pass the arguments to the program as a list, with no shell.",
  "phantom-tool":
    "Keep the tools in a Map, or check that the name is an own key, before calling one.",
  crash:
    "Catch the failure and return it as an error result. The server has to outlive a bad argument.",
  hang: "Put a limit on the work one call may do, and answer when it is reached.",
  "bad-reply": "Answer every request with a result or an error.",
  "schema-not-enforced":
    "Check the arguments against the schema the tool publishes before running it.",
  "loopback-fetch":
    "If the server can run where other services are reachable, refuse loopback and private addresses.",
  "soft-errors":
    "Answer a call that failed with isError, or with a JSON-RPC error, so a client can tell it from one that worked.",
};

const TIERS: readonly FindingTier[] = ["safety", "robustness", "note"];

export type ScanTotals = Record<FindingTier, number>;

export function scanTotals(findings: readonly Finding[]): ScanTotals {
  const totals: ScanTotals = { safety: 0, robustness: 0, note: 0 };
  for (const finding of findings) totals[finding.tier] += 1;
  return totals;
}

export function formatScan(report: ScanReport): string {
  const lines = [
    `scan: ${clean(report.name)}`,
    `server: ${clean(report.server)}`,
    "",
  ];
  const rows = report.tools.map((tool) => {
    const quiet = tool.status !== "scanned";
    return [
      clean(tool.name),
      tool.status,
      quiet ? "-" : String(tool.calls),
      quiet ? "-" : tool.plain,
      tool.status === "skipped" ? "-" : String(tool.strings),
      quiet ? "-" : String(tool.paths),
      quiet ? "-" : String(tool.findings),
      clean(tool.reason ?? ""),
    ];
  });
  lines.push(
    table(rows, [
      "tool",
      "status",
      "calls",
      "plain call",
      "strings",
      "paths",
      "findings",
      "",
    ]),
    "",
  );
  if (report.tools.some((tool) => tool.status === "planned")) {
    const planned = report.tools.filter((tool) => tool.status === "planned");
    lines.push(
      `${planned.length} of ${report.tools.length} tools would be called. No tool was called.`,
      ...heldLines(report),
    );
    return `${lines.join("\n")}\n`;
  }
  const ordered = [...report.findings].sort(
    (left, right) => TIERS.indexOf(left.tier) - TIERS.indexOf(right.tier),
  );
  // One entry for every tool that does not check its schema. It is the same
  // fix in the same place, and ten entries for it would bury the rest.
  const unchecked = ordered.filter(
    (finding) => finding.kind === "schema-not-enforced",
  );
  const entries: Finding[][] = [];
  for (const finding of ordered) {
    if (finding.kind !== "schema-not-enforced") entries.push([finding]);
    else if (finding === unchecked[0]) entries.push(unchecked);
  }
  if (entries.length > 0) lines.push("findings:", "");
  entries.forEach((group, index) => {
    const [finding] = group;
    if (!finding) return;
    const cwe = finding.cwe.length > 0 ? `  ${finding.cwe.join(", ")}` : "";
    if (finding.kind === "schema-not-enforced") {
      lines.push(
        `${index + 1}. ${finding.tier}  ${finding.kind}  ${group.length} ${group.length === 1 ? "tool" : "tools"}${cwe}`,
        "   The server gave a result for arguments its own schema rules out.",
      );
      for (const item of group) {
        lines.push(
          `   ${clean(item.tool)}: ${clean((item.accepted ?? []).join("; "))}`,
        );
      }
      lines.push(
        `   call: ${clean(finding.call)}`,
        `   fix:  ${FIX[finding.kind]}`,
        "",
      );
      return;
    }
    const where =
      finding.argument === undefined
        ? clean(finding.tool)
        : `${clean(finding.tool)}.${clean(finding.argument)}`;
    lines.push(
      `${index + 1}. ${finding.tier}  ${finding.kind}  ${where}${cwe}`,
      `   ${clean(finding.detail)}`,
      `   call: ${clean(finding.call)}`,
      `   fix:  ${FIX[finding.kind]}`,
    );
    if (finding.more > 0) {
      lines.push(
        `   ${finding.more} more ${finding.more === 1 ? "payload" : "payloads"} on this argument did the same.`,
      );
    }
    lines.push("");
  });
  const totals = scanTotals(report.findings);
  lines.push(
    `${totals.safety} safety, ${totals.robustness} robustness, ${totals.note} ${totals.note === 1 ? "note" : "notes"}.`,
  );
  const scanned = report.tools.filter((tool) => tool.status === "scanned");
  const answered = scanned.filter((tool) => tool.plain === "answered");
  const quiet = scanned.length - answered.length;
  lines.push(
    `${answered.length} of ${scanned.length} scanned ${scanned.length === 1 ? "tool" : "tools"} answered a plain call.`,
  );
  if (quiet > 0) {
    lines.push(
      `No finding means little for ${quiet === scanned.length ? "them" : `the other ${quiet}`}: a tool that turns every call down gives nothing to find.`,
    );
  }
  lines.push(...heldLines(report));
  if (report.stopped !== undefined) {
    lines.push(`The scan ended early: ${clean(report.stopped)}.`);
  }
  if (report.leftover !== undefined) {
    lines.push(
      `A call left something that could not be removed. It is in ${clean(report.leftover)}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// How many tools were left alone for what they might do, and the flag that
// calls them.
export function heldCounts(report: ScanReport): {
  writes: number;
  destructive: number;
} {
  const count = (reasons: readonly string[]): number =>
    report.tools.filter(
      (tool) => tool.reason !== undefined && reasons.includes(tool.reason),
    ).length;
  return {
    writes: count(Object.values(WRITES)),
    destructive: count(Object.values(HELD)),
  };
}

function heldLines(report: ScanReport): string[] {
  const { writes, destructive } = heldCounts(report);
  const lines: string[] = [];
  if (writes > 0) {
    lines.push(
      `${writes} ${writes === 1 ? "tool was" : "tools were"} not called because nothing marks or names ${writes === 1 ? "it" : "them"} as only reading. --write calls ${writes === 1 ? "it" : "them"} too, with made-up arguments.`,
    );
  }
  if (destructive > 0) {
    lines.push(
      `${destructive} ${destructive === 1 ? "tool was" : "tools were"} not called because ${destructive === 1 ? "it is" : "they are"} marked or named as removing, sending, or spending. --destructive calls ${destructive === 1 ? "it" : "them"} too.`,
    );
  }
  return lines;
}

export function formatScanJson(report: ScanReport): string {
  const json = JSON.stringify(
    {
      name: report.name,
      server: report.server,
      tools: report.tools,
      findings: report.findings.map((finding) => ({
        ...finding,
        fix: FIX[finding.kind],
      })),
      totals: scanTotals(report.findings),
      ...(report.stopped === undefined ? {} : { stopped: report.stopped }),
      ...(report.leftover === undefined ? {} : { leftover: report.leftover }),
    },
    null,
    2,
  );
  // What a server says about itself is in here. A control or format
  // character in it is written as an escape, as in the text report.
  return `${printableJson(json)}\n`;
}

const clean = printable;

function table(
  rows: readonly (readonly string[])[],
  headers: readonly string[],
): string {
  const widths = headers.map((header, index) =>
    rows.reduce(
      (width, row) => Math.max(width, (row[index] ?? "").length),
      header.length,
    ),
  );
  const render = (row: readonly string[]): string =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [render(headers), ...rows.map(render)].join("\n");
}
