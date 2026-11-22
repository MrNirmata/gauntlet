import type { Scenario } from "../types.ts";
import { jsonScenarios } from "./json.ts";
import { pathScenarios } from "./path.ts";
import { runtimeScenarios } from "./runtime.ts";
import { unicodeScenarios } from "./unicode.ts";
import { whitespaceScenarios } from "./whitespace.ts";
import { xmlScenarios } from "./xml.ts";

// The order here is the order of every report.
export const scenarios: readonly Scenario[] = [
  ...whitespaceScenarios,
  ...jsonScenarios,
  ...xmlScenarios,
  ...unicodeScenarios,
  ...pathScenarios,
  ...runtimeScenarios,
];
