import { asRunOutput } from "./output.ts";
import { createSandbox, deleteSandbox } from "./sandbox.ts";
import { splitCall } from "./structured.ts";
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
  const probes: ProbeRecord[] = [];
  const finish = (status: Result["status"], reason: string): Result => ({
    id: scenario.id,
    title: scenario.title,
    category: scenario.category,
    tier: scenario.tier,
    status,
    reason: oneLine(reason),
    probes,
  });
  // A target that receives parsed calls cannot be asked how it reads text
  // that is not one.
  if (options.structured === true && scenario.layer === "parse") {
    return finish(
      "not-covered",
      "the payload is raw model text, and this target receives parsed calls",
    );
  }
  const sandbox = createSandbox();
  try {
    scenario.prepare?.(sandbox);
    const outputs: RunOutput[] = [];
    for (const probe of scenario.probes) {
      const raw = probe(sandbox);
      let output: RunOutput;
      try {
        output = await runProbe(
          adapter,
          probeInput(raw, sandbox.workspaceDir, scenario, options),
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
    if (uncovered) {
      // One uncovered probe must not hide what the others did. Judge the
      // rest as if the uncovered probes had refused. A failure stands, and a
      // pass is still not-covered, because part of the scenario did not run.
      if (outputs.some((output) => output.status !== "not-covered")) {
        const check = scenario.expect({
          outputs: outputs.map((output) =>
            output.status === "not-covered"
              ? { status: "refused", reason: output.reason }
              : output,
          ),
          sandbox,
        });
        if (!check.ok) return finish("fail", check.reason);
      }
      return finish("not-covered", uncovered.reason);
    }
    const check = scenario.expect({ outputs, sandbox });
    return finish(check.ok ? "pass" : "fail", check.reason);
  } catch (error) {
    return finish("error", errorMessage(error));
  } finally {
    // The adapter lets go of the sandbox before the sandbox goes away.
    try {
      await adapter.close?.();
    } catch {
      // Stopping failed. The scenario's result stands.
    }
    deleteSandbox(sandbox);
  }
}

function probeInput(
  raw: string,
  sandboxDir: string,
  scenario: Scenario,
  options: RunOptions,
): AdapterRunInput {
  const input = { raw, sandboxDir, aborted: scenario.aborted };
  if (options.structured !== true) return input;
  const split = splitCall(raw);
  if (!split) {
    throw new Error(`scenario ${scenario.id} has a payload that is not a call`);
  }
  return { ...input, call: split.call };
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
  const line = reason.split(/\r\n|\r|\n/)[0];
  return line !== undefined && line.length > 0 ? line : "unknown error";
}
