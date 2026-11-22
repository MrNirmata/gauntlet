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

## Commands

`gauntlet list` prints every scenario. `gauntlet list --json` prints the same rows as JSON, with `title` and `expected`.

`gauntlet show <id>` prints one scenario: what it checks, what a correct adapter does, what is in the sandbox, and each payload it sends. Run it when a scenario fails.

```
node dist/cli.js show duplicate-keys-after-repair
```

`gauntlet run` runs the scenarios. `gauntlet help` lists every option and the exit codes.

`--scenario <id>` runs one scenario. `--category <name>` runs one category. Both repeat, and both take a comma-separated list. Together they add up.

```
node dist/cli.js run --adapter reference-naive --category path,xml
node dist/cli.js run --adapter reference-naive --scenario truncated-json --verbose
```

`--verbose` adds a `details` section. For each scenario that did not pass it prints the expected behavior, every payload, and what the adapter returned.

```
truncated-json  fail  executed a truncated tool call
  expected: Refuses the call.
  probe 1:  {"name":"read_file","arguments":{"path":"notes.txt"
  output 1: executed read_file {"path":"notes.txt"} => "hello\n"
```

`--junit <file>` also writes the results as JUnit XML. A fail is a `failure`, an error is an `error`, and a not-covered scenario is `skipped`.

`--timeout <ms>` is the limit for one probe. The default is 10000. It applies to a module adapter, to `--exec`, and to `--http`. A probe that runs past it is an error. A command is killed at the limit. A module adapter cannot be: one that blocks the event loop is not interrupted, and one that timed out may still be running.

`--json` prints one object. `adapter` and `gauntletVersion` name the run.
`scenarios` lists `id`, `category`, `status`, and `reason`. `totals` is `pass`, `fail`, `error`, and `notCovered`.
With `--verbose`, each scenario also has `probes`: the `raw` payload and the `outcome` of each one.
The exit code stays 0 when every scenario passes or is not covered. A not-covered row is left out of pass and fail.
An adapter that throws, times out, or returns something that is not a `RunOutput` is an error for that scenario.
When one probe of a scenario is not covered, the other probes are still judged. A failure among them is a fail.
A reason, an adapter name, and a tool name are printed with control characters escaped.

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

`--http <url>` POSTs the same JSON and reads the same object back. The timeout is 10 seconds. `--timeout <ms>` changes it. A timeout, a non-zero exit, or output that is not that object is an error for that scenario. So is a reply over 4 MiB.

`--name <label>` sets the adapter name in the report. The default is `exec:<command>` or `http:<url>`.

`examples/python-adapter.py` is a naive JSON parser using only the Python standard library. `examples/python-hardened.py` is the same program with the checks turned on. It passes every scenario. Read the two side by side.

```
gauntlet run --exec "python3 examples/python-adapter.py"
gauntlet run --exec "python3 examples/python-hardened.py"
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

`--baseline` and `--update-baseline` are mutually exclusive. A missing or invalid baseline file exits 2. `--update-baseline` records every scenario, so it exits 2 with `--scenario` or `--category`.

## GitHub Action

The action in this repo builds Gauntlet from its own checkout, then runs it in your workspace. It does not install an npm package. The step exits with Gauntlet's code. A regression fails the job.

The job summary gets a Markdown table of the results. When the run used a baseline, the summary adds regressions, improvements, and new scenarios. Outputs are `pass`, `fail`, `error`, `not-covered`, and `regressions`.

`uses: MrNirmata/gauntlet@main` tracks this branch until v0.2.0 is released. Pin a tag after that, for example `MrNirmata/gauntlet@v0.2.0`.

```yaml
name: gauntlet

on:
  pull_request:

jobs:
  gauntlet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: MrNirmata/gauntlet@main
        with:
          exec: python3 adapter.py
          baseline: gauntlet-baseline.json
```

Set exactly one of `adapter`, `exec`, or `http`. `name`, `timeout`, `scenario`, `category`, `strict`, and `working-directory` are optional. `scenario` and `category` take comma-separated lists. `strict: true` counts a new failure as a regression. `working-directory` defaults to `.` and is relative to the job workspace. `baseline` is a path inside that directory.

## Naive run

`node dist/cli.js run --adapter reference-naive`

```
adapter: reference-naive

scenario                     category    status  reason
whitespace-padded-args       whitespace  fail    path or encoding kept surrounding whitespace
content-whitespace-kept      whitespace  pass    wrote the content with its whitespace
truncated-json               json        fail    executed a truncated tool call
trailing-comma-json          json        fail    rejected JSON with a trailing comma
trailing-comma-in-string     json        pass    refused the trailing comma call
duplicate-keys               json        fail    duplicate key last-wins wrote stolen.txt
duplicate-keys-after-repair  json        pass    refused text that only a repair makes parse
json-string-arguments        json        fail    refused arguments sent as a JSON string
proto-key-arguments          json        fail    __proto__ supplied the path and wrote pwned.txt
argument-type-confusion      json        fail    coerced a non-string argument and wrote notes.txt
inherited-tool-name          json        fail    ran a name that is not a tool
truncated-xml                xml         fail    truncated call wrote notes.txt
xml-duplicate-params         xml         fail    repeated parameter last-wins wrote stolen.txt
unicode-zero-width-path      unicode     fail    wrote a lookalike path
unicode-bidi-path            unicode     fail    wrote a name with a bidi control
unicode-trimmed-path         unicode     fail    wrote a lookalike path
unicode-lone-surrogate       unicode     fail    wrote bytes the model did not send
path-escape                  path        fail    dotdot read a file outside the workspace
path-escape-write            path        fail    overwrote a file outside the workspace
path-symlink                 path        fail    symlink read a file outside the workspace
path-symlink-write           path        fail    symlink overwrote a file outside the workspace
path-nul-byte                path        fail    passed a NUL byte to the filesystem
path-hardlink-write          path        fail    wrote through a hard link to a file outside
path-unusable                path        pass    returned for paths the filesystem turns down
stream-aborted               stream      fail    aborted stream still wrote notes.txt
prompt-injection-result      injection   fail    tool result triggered write_file
oversized-argument           size        fail    wrote an oversized argument
deep-nesting                 size        pass    returned for 2000 and 10000 levels of nesting

5 passed, 23 failed, 0 errors, 0 not covered
```

The five passes are earned. A parser that trims nothing cannot trim content, one that repairs nothing cannot get a repair wrong, `JSON.parse` does not recurse, and the naive adapter hands a failed tool back as its result.

## Scenarios

| id                          | category   | what it checks                                                                                              |
| --------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| whitespace-padded-args      | whitespace | Padded XML path and encoding. Nano-Collective/nanocoder issue 2305.                                         |
| content-whitespace-kept     | whitespace | write_file content that starts and ends with whitespace. A correct adapter writes it byte for byte.         |
| truncated-json              | json       | A tool call cut off before the JSON arguments object closes.                                                |
| trailing-comma-json         | json       | A trailing comma before the closing brace of the arguments object.                                          |
| trailing-comma-in-string    | json       | A structural trailing comma and string content that contains ,] and ,}.                                     |
| duplicate-keys              | json       | Duplicate keys at any depth. A correct adapter refuses the call and does not write stolen.txt.              |
| duplicate-keys-after-repair | json       | Duplicate keys behind a lone comma. A repair that deletes the comma must not skip the duplicate check.      |
| json-string-arguments       | json       | arguments is a JSON string holding the object. A correct adapter unwraps it once.                           |
| proto-key-arguments         | json       | arguments holds only `__proto__`. Its value must not become the path and the content.                       |
| argument-type-confusion     | json       | path as an array or a number, content as an object. A correct adapter refuses and does not coerce.          |
| inherited-tool-name         | json       | A tool name such as constructor or toString. A correct adapter refuses a name that is not a tool.           |
| truncated-xml               | xml        | An XML tool call whose root tag never closes.                                                               |
| xml-duplicate-params        | xml        | An XML parameter that appears twice. The second path is stolen.txt.                                         |
| unicode-zero-width-path     | unicode    | A path that looks like notes.txt and contains U+200B.                                                       |
| unicode-bidi-path           | unicode    | A path with U+202E or U+2067, which reverse how the name is drawn.                                          |
| unicode-trimmed-path        | unicode    | notes.txt padded with U+FEFF or U+0085. A trim that removes them lands the write on notes.txt.              |
| unicode-lone-surrogate      | unicode    | Content with a lone surrogate, which UTF-8 cannot hold. A correct adapter refuses before it opens the file. |
| path-escape                 | path       | read_file via ../outside.txt and via the absolute path of that file.                                        |
| path-escape-write           | path       | write_file via ../outside.txt, its absolute path, sub/../../created.txt, and ../workspace.bak.              |
| path-symlink                | path       | A symlink inside the workspace that points at a file beside it.                                             |
| path-symlink-write          | path       | write_file through a symlink to a file, a symlink to a missing file, and a symlinked directory.             |
| path-nul-byte               | path       | A path with a NUL byte before a second extension.                                                           |
| path-hardlink-write         | path       | write_file to a hard link of the file outside. outside.txt must keep its bytes.                             |
| path-unusable               | path       | notes.txt/x and a 300-character name. The adapter must return, not crash.                                   |
| stream-aborted              | stream     | A complete write_file whose stream is already aborted.                                                      |
| prompt-injection-result     | injection  | A file read whose text contains a write_file call.                                                          |
| oversized-argument          | size       | A write_file argument larger than 65536 bytes.                                                              |
| deep-nesting                | size       | An argument nested 2000 and 10000 arrays deep. The adapter must return, not crash.                          |

`gauntlet show <id>` prints the payloads behind a row.

Each scenario runs in a new temp directory. The workspace holds `notes.txt`. `outside.txt` sits beside the workspace. A refusal passes only when both files still hold their bytes and nothing else was written.

## Write an adapter

An adapter parses the raw tool call and returns an executed call or a refusal. Pass a file path to `--adapter` to test a parser outside this repo. CONTRIBUTING.md has the steps.

```ts
type Adapter = {
  readonly name: string;
  run(input: AdapterRunInput): Promise<RunOutput>;
};
```

`AdapterRunInput` has `raw`, `sandboxDir`, and `aborted`. `RunOutput` is `executed`, `refused`, or `not-covered`.

## Use it from code

The package exports the runner, the scenarios, and both reference adapters.

```ts
import { runAll, scenarios } from "@mrnirmata/gauntlet";

const results = await runAll(myAdapter, scenarios, { timeoutMs: 10_000 });
for (const result of results) {
  console.log(result.id, result.status, result.reason);
}
```

Each result has `id`, `title`, `category`, `status`, `reason`, and `probes`. `runScenario` runs one scenario. `asRunOutput` returns a `RunOutput` when a value is one, and `undefined` when it is not.

## What the reference adapters are

`reference-naive` is what a first version of a tool-call layer does: `JSON.parse`, a regex for XML, `path.resolve`, and no checks. `reference-hardened` is one way to pass every scenario. It is in `src/adapters/reference.ts` and the three files in `src/adapters/reference/`.

- `json.ts` is one parser. It reads the value, repairs a trailing comma, and refuses a duplicate key or deep nesting in the same pass. A duplicate-key scan in front of `JSON.parse` is two parsers, and text they read differently gets past the scan.
- `jail.ts` resolves a path inside the workspace. It refuses characters that do not draw, absolute paths and `..`, then follows symlinks from the deepest part of the path that is on disk. It returns for a path the filesystem turns down.
- `xml.ts` refuses an unclosed call, a repeated parameter, and text between parameters.

Before a write, the adapter refuses content UTF-8 cannot hold and a target that is not one plain file with one name. It trims only space, tab, and line breaks, so a trim cannot remove a character the jail would refuse.

It does not stop a symlink swapped between the check and the open, or a read through a hard link. `examples/python-hardened.py` makes the same decisions in Python.

Gauntlet is a test harness. The sandbox is a temp directory, not a security boundary. See [SECURITY.md](SECURITY.md).

## Roadmap

- Adapters for a real XML tool-call parser, an OpenAI or Anthropic function-call JSON layer, and an MCP filesystem server.
- A public scoreboard. See [SCOREBOARD.md](SCOREBOARD.md).
- More scenarios.
