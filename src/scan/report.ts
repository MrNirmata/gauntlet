import type { Finding, FindingKind, FindingTier, ScanReport } from "./scan.ts";

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
  const rows = report.tools.map((tool) => [
    clean(tool.name),
    tool.status,
    tool.status === "skipped" ? "-" : String(tool.calls),
    tool.status === "skipped" ? "-" : tool.answered ? "answered" : "refused",
    tool.status === "skipped" ? "-" : String(tool.findings),
    tool.reason ?? "",
  ]);
  lines.push(
    table(rows, ["tool", "status", "calls", "plain call", "findings", ""]),
    "",
  );
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
  const quiet = scanned.filter((tool) => !tool.answered);
  if (scanned.length > 0) {
    lines.push(
      `${scanned.length - quiet.length} of ${scanned.length} scanned tools answered a plain call.`,
    );
  }
  const marked = report.tools.filter(
    (tool) => tool.reason === "the server marks it destructive",
  );
  if (marked.length > 0) {
    lines.push(
      `${marked.length} ${marked.length === 1 ? "tool was" : "tools were"} not called because the server marks ${marked.length === 1 ? "it" : "them"} destructive. --destructive calls ${marked.length === 1 ? "it" : "them"} too.`,
    );
  }
  if (quiet.length > 0) {
    lines.push(
      `No finding means little for the other ${quiet.length}: a server that turns every call down gives nothing to find.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatScanJson(report: ScanReport): string {
  return `${JSON.stringify(
    {
      name: report.name,
      server: report.server,
      tools: report.tools,
      findings: report.findings.map((finding) => ({
        ...finding,
        fix: FIX[finding.kind],
      })),
      totals: scanTotals(report.findings),
    },
    null,
    2,
  )}\n`;
}

// Text from a server goes to a terminal. Control and format characters in
// it are shown as escapes, not acted on.
function clean(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => {
    const code = char.codePointAt(0) ?? 0;
    const hex = code.toString(16);
    return code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  });
}

function table(
  rows: readonly (readonly string[])[],
  headers: readonly string[],
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const render = (row: readonly string[]): string =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [render(headers), ...rows.map(render)].join("\n");
}
