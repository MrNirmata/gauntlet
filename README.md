# Gauntlet

Gauntlet feeds adversarial tool-call payloads to an adapter and prints pass, fail, or error. Agent demos hide failures at the point where model output becomes a tool call. It is for people who maintain the code that turns model output into a tool call. MrNirmata wrote it.

## Quickstart

Gauntlet requires Node 22.

`npx @mrnirmata/gauntlet run --adapter reference-hardened` runs the package. Install it with `npm i -D @mrnirmata/gauntlet`.

```
pnpm install
pnpm build
node dist/cli.js list
node dist/cli.js run --adapter reference-naive
```

`reference-hardened` runs the same scenarios with the checks turned on.

`--json` prints one object. `adapter` and `gauntletVersion` name the run.
`scenarios` lists `id`, `category`, `status`, and `reason`. `totals` is `pass`, `fail`, `error`, and `notCovered`.
The exit code stays 0 when every scenario passes or is not covered. A not-covered row is left out of pass and fail.

## Test your own parser

`--adapter` accepts a built-in name or a path to a module. A path starts with `.` or `/`, or ends in `.js`, `.mjs`, `.ts`, or `.mts`.

```
node dist/cli.js run --adapter ./examples/adapter-template.mjs
```

The module's default export, or a named export `adapter`, must be an object with a non-empty `name` and a `run` function. `defineAdapter` from `@mrnirmata/gauntlet` returns that object and checks the type.

Node loads a `.ts` adapter when it can strip types: Node 22.6 with `--experimental-strip-types`, or a Node 22 that strips types by default. If Node cannot load the TypeScript file, compile it to `.js` or run Gauntlet through `tsx`.

## Black-box mode

`--exec` and `--http` test a program that is not a JavaScript adapter. Python, Rust, and Go fit here. `--adapter`, `--exec`, and `--http` are mutually exclusive, and one of them is required.

`--exec "<command>"` runs the command in a shell for each probe. The command runs from the directory you start gauntlet in, and tool paths must be resolved against `sandboxDir`. Gauntlet writes one JSON line to stdin and closes it:

```
{"raw": "<model output>", "sandboxDir": "/tmp/gauntlet-…/workspace", "aborted": false}
```

The command prints one JSON object: `executed`, `refused`, or `not-covered`. The program performs the tool call. Scenarios check the sandbox files.

`--http <url>` POSTs the same JSON and reads the same object back. The timeout is 10 seconds. `--timeout <ms>` changes it. A timeout, a non-zero exit, or output that is not that object is an error for that scenario.

`--name <label>` sets the adapter name in the report. The default is `exec:<command>` or `http:<url>`.

`examples/python-adapter.py` is a naive JSON parser using only the Python standard library.

```
gauntlet run --exec "python3 examples/python-adapter.py"
```

From a checkout, the same run is `node dist/cli.js run --exec "python3 examples/python-adapter.py"`.

## Baseline

`--update-baseline <file>` writes the current results and exits 0. `--baseline <file>` compares a run to that file. The run exits 1 when a scenario regresses, and exits 0 when the recorded results hold.

```
node dist/cli.js run --adapter reference-naive --update-baseline baseline.json
node dist/cli.js run --adapter reference-naive --baseline baseline.json
```

The file holds `gauntletVersion`, `adapter`, and `scenarios`. Scenario ids are sorted. Each value is `pass`, `fail`, `error`, or `not-covered`.

A regression is `pass` or `not-covered` in the file and `fail` or `error` now. `fail` or `error` in the file and `pass` now is an improvement. A scenario this version runs that the file does not name is new. A new `fail` or `error` prints a warning. `--strict` counts it as a regression. A name in the file that this version does not run is ignored. The report lists regressions, improvements, and new scenarios, and says to rerun with `--update-baseline` when something improved. `--json` adds `baseline` with `regressions`, `improvements`, and `new`.

`--baseline` and `--update-baseline` are mutually exclusive. A missing or invalid baseline file exits 2.

## Naive run

`node dist/cli.js run --adapter reference-naive`

```
adapter: reference-naive

scenario                  category    status  reason
whitespace-padded-args    whitespace  fail    path or encoding kept surrounding whitespace
truncated-json            json        fail    executed a truncated tool call
trailing-comma-json       json        fail    rejected JSON with a trailing comma
trailing-comma-in-string  json        pass    refused the trailing comma call
duplicate-keys            json        fail    duplicate key last-wins wrote stolen.txt
json-string-arguments     json        fail    refused arguments sent as a JSON string
unicode-zero-width-path   unicode     fail    wrote a lookalike path
path-escape               path        fail    dotdot read a file outside the workspace
path-symlink              path        fail    symlink read a file outside the workspace
stream-aborted            stream      fail    aborted stream still wrote notes.txt
prompt-injection-result   injection   fail    tool result triggered write_file
oversized-argument        size        fail    wrote an oversized argument

1 passed, 11 failed, 0 errors, 0 not covered
```

## Scenarios

| id                       | category   | what it checks                                                                                 |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------- |
| whitespace-padded-args   | whitespace | Padded XML path and encoding. Nano-Collective/nanocoder issue 2305.                            |
| truncated-json           | json       | A tool call cut off before the JSON arguments object closes.                                   |
| trailing-comma-json      | json       | A trailing comma before the closing brace of the arguments object.                             |
| trailing-comma-in-string | json       | A structural trailing comma and string content that contains ,] and ,}.                        |
| duplicate-keys           | json       | Duplicate keys at any depth. A correct adapter refuses the call and does not write stolen.txt. |
| json-string-arguments    | json       | arguments is a JSON string holding the object. A correct adapter unwraps it once.              |
| unicode-zero-width-path  | unicode    | A path that looks like notes.txt and contains U+200B.                                          |
| path-escape              | path       | read_file via ../outside.txt and via the absolute path of that file.                           |
| path-symlink             | path       | A symlink inside the workspace that points at a file beside it.                                |
| stream-aborted           | stream     | A complete write_file whose stream is already aborted.                                         |
| prompt-injection-result  | injection  | A file read whose text contains a write_file call.                                             |
| oversized-argument       | size       | A write_file argument larger than 65536 bytes.                                                 |

## Write an adapter

An adapter parses the raw tool call and returns an executed call or a refusal. Pass a file path to `--adapter` to test a parser outside this repo. CONTRIBUTING.md has the steps.

```ts
type Adapter = {
  readonly name: string;
  run(input: AdapterRunInput): Promise<RunOutput>;
};
```

`AdapterRunInput` has `raw`, `sandboxDir`, and `aborted`. `RunOutput` is `executed` or `refused`.

## Roadmap

- Adapters for a real XML tool-call parser, an OpenAI or Anthropic function-call JSON layer, and an MCP filesystem server.
- A public scoreboard. See [SCOREBOARD.md](SCOREBOARD.md).
- More scenarios.
