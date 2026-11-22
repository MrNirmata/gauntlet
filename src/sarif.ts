import type { Result, Scenario } from "./types.ts";

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const INFORMATION_URI = "https://github.com/MrNirmata/gauntlet";

// SARIF 2.1.0, the format code-scanning tools read. Each scenario is a rule
// and each result of the run is a result. A failed safety scenario is an
// error, a failed robustness scenario is a warning, and an adapter that
// threw is an error whatever the tier.
//
// A viewer that shows results by file needs a file. `location` is that file:
// the module, script, or config that holds the code under test.
export function formatSarif(
  adapterName: string,
  version: string,
  results: readonly Result[],
  scenarios: readonly Scenario[],
  location?: string,
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
  const sarifResults = results.map((result) => {
    const scenario = byId.get(result.id);
    const failed = result.status === "fail" || result.status === "error";
    const index = ruleIndex.get(result.id);
    return {
      ruleId: result.id,
      ...(index === undefined ? {} : { ruleIndex: index }),
      kind:
        result.status === "pass"
          ? "pass"
          : result.status === "not-covered"
            ? "notApplicable"
            : "fail",
      // level is "none" unless the result is a failure.
      level: !failed
        ? "none"
        : result.status === "error"
          ? "error"
          : failLevel(scenario?.tier ?? result.tier),
      message: {
        text:
          result.status === "error"
            ? `The adapter did not return: ${result.reason}`
            : result.reason,
      },
      ...(failed && location !== undefined
        ? {
            locations: [
              { physicalLocation: { artifactLocation: { uri: location } } },
            ],
          }
        : {}),
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
        automationDetails: { id: `gauntlet/${adapterName}` },
        results: sarifResults,
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}

function failLevel(tier: Result["tier"]): "error" | "warning" {
  return tier === "robustness" ? "warning" : "error";
}
