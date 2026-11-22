import type { Adapter } from "./types.ts";

export { adapters } from "./adapters/index.ts";
export { mcpAdapter } from "./adapters/mcp.ts";
export { referenceHardened, referenceNaive } from "./adapters/reference.ts";
export { asRunOutput } from "./output.ts";
export { runAll, runScenario } from "./run.ts";
export { FIXTURE_NOTE, FIXTURE_SECRET } from "./sandbox.ts";
export { formatSarif } from "./sarif.ts";
export { scenarios } from "./scenarios/index.ts";
export { splitCall } from "./structured.ts";
export type {
  Adapter,
  AdapterRunInput,
  Category,
  Check,
  Classification,
  Layer,
  ProbeRecord,
  Result,
  RunOptions,
  RunOutput,
  Sandbox,
  Scenario,
  ScenarioCase,
  Status,
  Tier,
  ToolCall,
} from "./types.ts";

export function defineAdapter(adapter: Adapter): Adapter {
  return adapter;
}
