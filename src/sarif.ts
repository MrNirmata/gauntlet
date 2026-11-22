import path from "node:path";
import type { Result, Scenario } from "./types.ts";

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const INFORMATION_URI = "https://github.com/MrNirmata/gauntlet";
const MAX_SLUG_CHARS = 60;

// SARIF 2.1.0, the format code-scanning tools read. Each scenario of the run
// is a rule, and each scenario that failed or errored is a result. A failed
// safety scenario is an error, a failed robustness scenario is a warning,
// and an adapter that threw is an error whatever the tier.
//
// A pass is not a finding, so it is not a result. The rules still list
// every scenario that ran.
//
// `location` is the file a viewer opens for a failure: the module, script,
// or config that holds the code under test. Every result has it, because a
// viewer that lists findings by file shows nothing for one without a file.
export function formatSarif(
  adapterName: string,
  version: string,
  results: readonly Result[],
  scenarios: readonly Scenario[],
  location: string,
): string {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const rules = [];
  const ruleIndex = new Map<string, number>();
  for (const result of results) {
    const scenario = byId.get(result.id);
    if (!scenario || ruleIndex.has(result.id)) continue;
    ruleIndex.set(result.id, rules.length);
    rules.push({
      id: scenario.id,
      name: scenario.title,
      shortDescription: { text: scenario.title },
      fullDescription: { text: scenario.summary },
      help: { text: `A correct adapter: ${scenario.expected}` },
      defaultConfiguration: { level: failLevel(scenario.tier) },
      properties: {
        tags: [
          scenario.tier,
          scenario.category,
          ...scenario.cwe.map((id) => `external/cwe/${id.toLowerCase()}`),
        ],
      },
    });
  }
  const uri = toUri(location);
  const findings = results
    .filter((result) => result.status === "fail" || result.status === "error")
    .map((result) => {
      const index = ruleIndex.get(result.id);
      return {
        ruleId: result.id,
        ...(index === undefined ? {} : { ruleIndex: index }),
        kind: "fail",
        level:
          result.status === "error"
            ? "error"
            : failLevel(byId.get(result.id)?.tier ?? result.tier),
        message: {
          text:
            result.status === "error"
              ? `The adapter did not return: ${result.reason}`
              : result.reason,
        },
        locations: [{ physicalLocation: { artifactLocation: { uri } } }],
      };
    });
  const log = {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Gauntlet",
            version,
            informationUri: INFORMATION_URI,
            rules,
          },
        },
        // The part before the last slash is the category a code-scanning
        // tool files the run under. One per target, so two targets in one
        // repository do not replace each other's findings.
        automationDetails: { id: `gauntlet/${slug(adapterName)}/` },
        results: findings,
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}

function failLevel(tier: Result["tier"]): "error" | "warning" {
  return tier === "robustness" ? "warning" : "error";
}

function slug(name: string): string {
  const text = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");
  return text.length > 0 ? text : "adapter";
}

// A URI reference relative to the directory the run started in: forward
// slashes, and each part percent-encoded. An absolute path would not be one,
// and would put the name of a home directory in the report.
function toUri(file: string): string {
  const relative = path.isAbsolute(file)
    ? path.relative(process.cwd(), file)
    : path.normalize(file);
  const parts = relative.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts.map(encodeURIComponent).join("/") : ".";
}
