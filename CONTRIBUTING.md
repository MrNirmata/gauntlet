# Contributing

Issues and pull requests are welcome. A useful change is one scenario or one adapter, with a test that shows the new behavior.

## Checks

Node 22 and pnpm are required.

```
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

After `pnpm build`, `node dist/cli.js run --adapter reference-naive` exits 1. That is the naive adapter failing the suite. `reference-hardened` exits 0.

## Add a scenario

Scenarios live in `src/scenarios/`, one file per group: `whitespace.ts`, `json.ts`, `xml.ts`, `unicode.ts`, `path.ts`, and `runtime.ts` for stream, injection, and size. Add an object to the array in the file that fits. `src/scenarios/index.ts` sets the order of every report.

Give it an id, a title, a category, a one-line `summary` that names the failure, and a one-line `expected` that says what a correct adapter does. `probes` returns the raw model output. `prepare` adds files to the sandbox, and `setup` says in one line what it added. `expect` reads the adapter output and the sandbox, and returns `{ ok, reason }`. `reason` is one line. The helpers in `src/scenarios/checks.ts` cover the usual checks. A refusal should pass only through `refusedAfterWrite`, so a refusal that already wrote is a fail.

Add the id to `src/scenarios/classify.ts` with a tier, a layer, and CWE ids. `safety` is harm: a file outside the workspace, a call nobody sent, bytes the model did not send. `robustness` is a call that should have worked and did not, or a crash. The layer is `execute` when every payload is a well-formed `{"name":…,"arguments":{…}}` call, and `parse` otherwise. An `execute` scenario also runs against MCP servers and structured adapters, so its check must hold for a target that never saw the text. Loading fails when an id is missing from the table.

`gauntlet show <id>` prints the new scenario the way a user will read it.

The check must hold in any language. Test what the adapter returned and what is on disk, not how a JavaScript parser happens to behave. `examples/python-hardened.py` passes every scenario, and a test keeps it that way. Extend it with the new case.

`reference-naive` should fail the new scenario. `reference-hardened` should pass it. Extend the policy object in `src/adapters/reference.ts` when the new case is another switch on the same executor. Add a third adapter only when the case is a different parser. When a correct but unhardened parser is safe from the case, the naive adapter may pass. Add the id to `NAIVE_PASSES` in `test/scenarios.test.ts` and say why in a comment.

`test/scenarios.test.ts` runs every scenario against both adapters. Add the row to the scenario table in README.md. A test fails when a scenario is missing from it. Add the id to the category list in `.github/ISSUE_TEMPLATE/scenario.yml` when the category is new.

## Add an adapter

Outside this repo, point `--adapter` at a file. `examples/adapter-template.mjs` is a working starting point. `defineAdapter` checks the type and returns the same object.

```ts
import { defineAdapter } from "@mrnirmata/gauntlet";

export default defineAdapter({
  name: "my-agent",
  async run({ raw, sandboxDir, aborted }) {
    if (aborted) return { status: "refused", reason: "stream aborted" };
    const call = parse(raw);
    if (!call) return { status: "refused", reason: "could not parse" };
    return executeInside(sandboxDir, call);
  },
});
```

To add a built-in adapter here, implement the `Adapter` type and add it to the `adapters` array in `src/adapters/index.ts`.

```ts
const mine: Adapter = {
  name: "my-agent",
  async run({ raw, sandboxDir, aborted }) {
    if (aborted) return { status: "refused", reason: "stream aborted" };
    const call = parse(raw);
    if (!call) return { status: "refused", reason: "could not parse" };
    return executeInside(sandboxDir, call);
  },
};
```

Gauntlet does not parse the payload before your adapter sees it. `run` receives the raw string, the workspace directory, and whether the stream aborted. Return `executed` with the tool call and the tool result, or `refused` with a one-line reason. Return `not-covered` when the check lives in code your adapter does not call.

The runner checks what `run` returns. A throw, a promise that does not settle within `--timeout`, or a value that is not a `RunOutput` is an error for that scenario.

The reference adapters understand two fixture shapes used by the built-in scenarios. XML is a root tag whose child elements are the arguments. JSON is `{"name":"tool","arguments":{...}}`. A real adapter can ignore both and parse whatever its agent emits. The scenario check only looks at the returned call and at files inside the sandbox.

Three adapters are intentionally not in v0.1. Open an issue before starting one.

- An XML tool-call parser, the Nano-Collective/nanocoder failure class.
- An OpenAI or Anthropic function-call JSON layer.
- An MCP filesystem server.

## Black-box mode

A program that is not a JavaScript module can use `--exec` or `--http`. Each probe is one JSON object with `raw`, `sandboxDir`, and `aborted`. The reply is one `RunOutput` object. The command runs from the directory you start gauntlet in, and tool paths must be resolved against `sandboxDir`. `examples/python-adapter.py` is a naive standard-library example, and `examples/python-hardened.py` passes every scenario.

```
gauntlet run --exec "python3 examples/python-adapter.py"
```

## Sandbox

The runner creates the temp directory. The adapter may only touch `sandboxDir`.
