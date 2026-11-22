import { asRunOutput } from "./output.ts";
import { createSandbox, deleteSandbox } from "./sandbox.ts";
import type {
  Adapter,
  AdapterRunInput,
  ProbeRecord,
  Result,
  RunOptions,
  RunOutput,
  Scenario,
} from "./types.ts";

export async function runScenario(
  adapter: Adapter,
  scenario: Scenario,
  options: RunOptions = {},
): Promise<Result> {
  const sandbox = createSandbox();
  const probes: ProbeRecord[] = [];
  const finish = (status: Result["status"], reason: string): Result => ({
    id: scenario.id,
    title: scenario.title,
    category: scenario.category,
    status,
    reason: oneLine(reason),
    probes,
  });
  try {
    scenario.prepare?.(sandbox);
    const outputs: RunOutput[] = [];
    for (const probe of scenario.probes) {
      const raw = probe(sandbox);
      let output: RunOutput;
      try {
        output = await runProbe(
          adapter,
          { raw, sandboxDir: sandbox.workspaceDir, aborted: scenario.aborted },
          options.timeoutMs,
        );
      } catch (error) {
        const reason = oneLine(errorMessage(error));
        probes.push({ raw, outcome: { status: "error", reason } });
        return finish("error", reason);
      }
      probes.push({ raw, outcome: output });
      outputs.push(output);
    }
    const uncovered = outputs.find((output) => output.status === "not-covered");
    if (uncovered) return finish("not-covered", uncovered.reason);
    const check = scenario.expect({ outputs, sandbox });
    return finish(check.ok ? "pass" : "fail", check.reason);
  } catch (error) {
    return finish("error", errorMessage(error));
  } finally {
    deleteSandbox(sandbox);
  }
}

export async function runAll(
  adapter: Adapter,
  scenarios: readonly Scenario[],
  options: RunOptions = {},
): Promise<Result[]> {
  const results: Result[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(adapter, scenario, options));
  }
  return results;
}

// An adapter is someone else's code. It can throw before it returns a
// promise, never settle, or resolve to something that is not a RunOutput.
async function runProbe(
  adapter: Adapter,
  input: AdapterRunInput,
  timeoutMs: number | undefined,
): Promise<RunOutput> {
  const pending = Promise.resolve().then(() => adapter.run(input));
  const value =
    timeoutMs === undefined
      ? await pending
      : await withTimeout(pending, timeoutMs);
  const output = asRunOutput(value);
  if (!output)
    throw new Error("adapter returned a value that is not a RunOutput");
  return output;
}

function withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`adapter timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 0 ? message : "unknown error";
}

function oneLine(reason: string): string {
  const line = reason.split("\n")[0];
  return line !== undefined && line.length > 0 ? line : "unknown error";
}
