import type { Scenario, ScenarioCase } from "../types.ts";
import { CLASSIFICATION } from "./classify.ts";
import { jsonScenarios } from "./json.ts";
import { pathScenarios } from "./path.ts";
import { runtimeScenarios } from "./runtime.ts";
import { unicodeScenarios } from "./unicode.ts";
import { whitespaceScenarios } from "./whitespace.ts";
import { xmlScenarios } from "./xml.ts";

function classify(item: ScenarioCase): Scenario {
  const classification = CLASSIFICATION[item.id];
  if (!classification) {
    throw new Error(`scenario ${item.id} is missing from classify.ts`);
  }
  return { ...item, ...classification };
}

// The order here is the order of every report.
export const scenarios: readonly Scenario[] = [
  ...whitespaceScenarios,
  ...jsonScenarios,
  ...xmlScenarios,
  ...unicodeScenarios,
  ...pathScenarios,
  ...runtimeScenarios,
].map(classify);
