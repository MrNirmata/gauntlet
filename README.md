# Gauntlet

Gauntlet feeds adversarial tool-call payloads to an adapter and prints pass, fail, or error. Agent demos hide failures at the point where model output becomes a tool call. It is for people who maintain the code that turns model output into a tool call. MrNirmata wrote it.

## What it is for

A model sends a tool call. Code you wrote reads it and runs it. Gauntlet sends that code the calls that go wrong in practice and reports what your code did with each one. It does this two ways.

`gauntlet scan` works on any MCP server. It reads the tools the server lists and the schema of each one, and calls every tool with arguments it builds from that schema: paths that leave the directory, shell metacharacters, `file://` addresses, 10000 nested arrays. No adapter is written, and the server does not have to be a file server.

```
gauntlet scan --mcp "node {cwd}/dist/server.js"
```

```
2. safety  outside-read  read_note.path  CWE-22
   The reply holds the contents of a file outside the server's directory, reached with a path that starts with ../.
   call: {"name":"read_note","arguments":{"path":"../gauntlet-b102cf42-outside.txt"}}
   fix:  Resolve the path against the allowed directory, follow symlinks, and refuse a result outside it.
   4 more payloads on this argument did the same.

3. safety  shell-injection  grep_notes.pattern  CWE-78
   A command inside the argument ran: a ; and a command created the marker file it names.
   call: {"name":"grep_notes","arguments":{"pattern":"gauntlet-b102cf42; touch /tmp/gauntlet-scan-x/guard/guard/outer/gauntlet-marker-1-9c41d0"}}
   fix:  Do not build a shell command from an argument. Pass the arguments to the program as a list, with no shell.
   5 more payloads on this argument did the same.
```

`gauntlet run` is the fixed suite: 28 scenarios for code that reads and writes files, each with an exact expected result. It tests a JavaScript adapter, a program in any language, an HTTP endpoint, or an MCP file server, and it is what the scoreboard and a CI baseline are built on.

If you are a team, the GitHub Action runs the suite on every pull request. `fail-on: safety` fails the build for a file written outside the workspace and not for a refused trailing comma. A baseline lets you turn it on before the code is clean.

If you answer for many agents and servers, `--sarif` writes the results in the format code-scanning tools read. Each scenario is a rule with its CWE id, so a failure lands in the same place as every other finding.

## Quickstart

Gauntlet requires Node 22.

`npx @mrnirmata/gauntlet run --adapter reference-hardened` runs the package. Install it with `npm i -D @mrnirmata/gauntlet`.

`gauntlet scan` needs 0.3.0, which is not published yet. `--mcp`, `--structured`, `--tier`, `--fail-on`, `--sarif`, and the scenarios after the first 12 need 0.2.0 or later. `gauntlet --version` prints what you have. From a checkout, `node dist/cli.js` stands in for `gauntlet`.

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

`--sarif <file>` also writes the results as SARIF 2.1.0. Each scenario that ran is a rule tagged with its tier, its category, and its CWE ids. Each scenario that failed or errored is a result. A failed safety scenario is an `error`, a failed robustness scenario is a `warning`, and an adapter that threw is an `error`. A pass is not a finding and is not in the file.

`--sarif-location <path>` names the file a viewer opens for a failure, relative to the directory you run in. It is required, because a viewer that lists findings by file shows nothing for one without a file. It defaults to the adapter module when `--adapter` is a path. `--name` becomes the category of the run, so two targets in one repository do not replace each other's findings.

`--timeout <ms>` is the limit for one probe. The default is 10000. It applies to a module adapter, to `--exec`, and to `--http`. A probe that runs past it is an error. A command is killed at the limit. A module adapter cannot be: one that blocks the event loop is not interrupted, and one that timed out may still be running.

`--json` prints one object. `adapter` and `gauntletVersion` name the run.
`scenarios` lists `id`, `category`, `status`, and `reason`. `totals` is `pass`, `fail`, `error`, and `notCovered`.
With `--verbose`, each scenario also has `tier` and `probes`: the `raw` payload and the `outcome` of each one.
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

## Scan any MCP server

`gauntlet scan --mcp "<command>"` starts the server, lists its tools, and calls each one.

```
gauntlet scan --mcp "node {cwd}/dist/server.js" --plan
gauntlet scan --mcp "node {cwd}/dist/server.js"
gauntlet scan --mcp "python3 {cwd}/server.py" --env API_KEY --tool search,fetch
```

`--plan` calls nothing. It lists the tools, which of them a scan would call, and why the others are left alone. Run it first on a server you did not write.

For each tool the scan first makes a plain call from the tool's schema: every required argument, with a value of its type. Then it puts payloads in every string argument, one at a time, and sends calls the schema forbids.

A finding is never a guess. Each one is something the scan saw:

| finding             | tier       | what the scan saw                                                                 |
| ------------------- | ---------- | --------------------------------------------------------------------------------- |
| outside-read        | safety     | A secret planted in a file beside the server's directory came back in a reply.    |
| outside-list        | safety     | The name of a file planted there, which was never sent, came back in a reply.     |
| outside-write       | safety     | A file beside the server's directory was changed, deleted, or created.            |
| shell-injection     | safety     | A marker file was created by a command that was inside an argument.               |
| url-file-read       | safety     | The planted secret came back for a `file://` address.                             |
| phantom-tool        | safety     | The server gave a result for a tool name it does not list, such as `constructor`. |
| crash               | robustness | The server process exited.                                                        |
| hang                | robustness | The server did not answer within `--timeout`.                                     |
| bad-reply           | robustness | A reply had no result and no error.                                               |
| schema-not-enforced | robustness | A call the tool's own schema rules out got a result.                              |
| loopback-fetch      | note       | The server fetched an address on this machine that an argument gave it.           |
| soft-errors         | note       | The server gave a result for a tool that does not exist.                          |

Each finding has the call that caused it, so you can send it again, and one line on the fix.

### What the report says it did not test

A scan that found nothing is worth as much as what it reached. The table has a row for each tool, and the row says how far the scan got.

```
tool            status   calls  plain call  strings  findings
read_file       scanned  26     answered    1        0
write_file      skipped  -      -           -        -         the server marks it destructive
get_file_info   scanned  20     answered    1        0         paths that leave a directory were not sent: the plain call was not seen to work in the scan's directory
web_search      scanned  14     refused     1        0
```

- `plain call: refused` means the tool turned down even a call with nothing odd in it, usually for a missing key or a file it wanted. No finding means little for that tool. `--env NAME` gives the server a variable it needs.
- `strings` is how many string arguments got payloads. A tool with `0` was sent only the calls its schema forbids.
- `paths that leave a directory were not sent` is on a tool that takes a path and was not seen to work in the scan's directory. The next section says why.
- A scan in which no tool answered a plain call exits 2. Nothing was tested, and that is not a pass.
- A server with the `soft-errors` note reports a failure as an ordinary result. For that server a result proves nothing, so `phantom-tool` and `schema-not-enforced` are not reported for it.

### What keeps a scan from costing you

A scan calls tools with made-up arguments. These rules are there so that a wrong guess stays cheap.

- The server runs in a directory four levels inside a new temp directory, and no payload goes further than one level above it. Its environment has `PATH`, a temp `HOME`, a temp `TMPDIR`, and no other variable of yours. A tool that needs a token does not have one unless you pass it with `--env`.
- A tool is not called if the server marks it destructive, or if its name says it removes, sends, or spends: `delete_`, `drop`, `send_`, `pay`, `publish`, `deploy`, and the like. `--destructive` calls those too, and so does naming one with `--tool`.
- A path that leaves a directory, such as `../x`, is sent only to a tool that was seen to work in the scan's own directory: its plain call returned the note planted there, listed a file planted there, or changed something there. A server that keeps its data in a directory of yours would resolve `../x` against that directory, and the scan could not see what happened. Such a tool gets no such path.
- A tool that was seen to work only with a path written in full gets paths written in full, all of them under the scan's temp directory.
- Every name the scan makes up starts with `gauntlet-` and eight random characters. No payload is an empty string, `/`, `~`, or a path of yours. The commands it tries to inject only `touch` a file in its temp directory.
- A tool that runs commands by design, by its name or its description, is not sent the command payloads. Running a command is not a finding there.
- A misspelled `--tool`, `--skip`, or `--ignore` name is an error before any tool is called.

That is not a sandbox. The server is your code running as you. A tool that does harm under a name the scan does not recognise is called, and a server can reach the network. Scan a server whose worst case you accept, with the credentials you would give a test. SECURITY.md has the rest.

### Options

`--tool` and `--skip` choose which tools are called. `--ignore <kind>` or `--ignore <kind>:<tool>` leaves a finding out, for a server that reads any file on purpose. `--fail-on safety` lets only safety findings fail the run, and `--fail-on none` never fails it. `--max-calls` limits the calls to one tool. `--json` prints the report as one object.

`scan` is new in 0.3.0 and may change.

## Safety and robustness

Every scenario has a tier.

- `safety`: the adapter did something it must never do. It read or wrote outside the workspace, ran a call nobody sent, wrote bytes the model did not send, or took input it should have turned down.
- `robustness`: the adapter turned down or damaged a call that should have worked, or it crashed.

A parser that refuses a trailing comma is strict, not unsafe. The two are counted apart, and the report has a line for each.

`--tier safety` runs one tier. `--fail-on safety` runs everything and lets only that tier decide the exit code. The default is `any`. Filters that leave nothing to run exit 2, and so does a `--fail-on` tier that `--tier` left out.

```
node dist/cli.js run --adapter reference-naive --fail-on safety
```

Each scenario also has a layer. A `parse` scenario is about reading model output: text that is not a well-formed call, or more of it than a reader should take. An `execute` scenario sends a well-formed call, and the failure is in running it. `gauntlet list --json` prints `tier`, `layer`, and `cwe` for each one.

## Test an MCP server

`--mcp "<command>"` starts an MCP server on stdio and sends each probe as a `tools/call` request. Gauntlet is the client.

```
gauntlet run --mcp "npx -y @modelcontextprotocol/server-filesystem {workspace}"
gauntlet run --mcp "node {cwd}/dist/server.js {workspace}"
```

The server is started once per scenario, in that scenario's workspace. `{workspace}` in the command is the path of that directory. `{cwd}` is the directory you started Gauntlet in. Both are already quoted for the shell, so do not put quotes around them. The server does not run there: a probe has a relative path, and a server that resolved it against your project would be reading and writing your project.

The server needs a tool that reads a file and a tool that writes one. `--tool` gives the server's names for the tools, and `--arg` its names for the two arguments.

```
gauntlet run --mcp "node {cwd}/server.js {workspace}" --tool read_file=read_text_file
gauntlet run --mcp "python3 {cwd}/server.py" --tool write_file=save --arg path=file_path --arg content=text
```

Before the run, Gauntlet starts the server once in an empty directory, asks it to write a file there, and asks it to read the file back. A server with one of the two tools is asked to do the one it can. A command that cannot start, a server with neither tool, or a server that fails what it was asked exits 2 with one message. The message lists the server's tools, or quotes what the server replied. A server with only one of the two tools runs, and the scenarios that need the other are `not-covered`.

That first call is what makes a pass mean something. Most scenarios expect a refusal. A server that turned every call down, because it calls the argument `file_path` or takes only absolute paths, would pass them all.

A JSON-RPC error and a result with `isError` are both a refusal. The text of a refusal still counts: one that quotes a file from outside the workspace has leaked it. A server that exits, or does not answer within `--timeout`, is an error for that scenario.

File text is read from `text` blocks, from embedded `resource` blocks, and from `structuredContent` when there is nothing else.

An MCP server receives a parsed call, so the `parse` scenarios are `not-covered`, and so is `stream-aborted`. The other 17 `execute` scenarios run. SCOREBOARD.md has the reference filesystem server.

`--timeout` is the limit for one request to the server, the start included. `npx -y` fetches the package on every start, and the server starts once per scenario. Install the server once and point the command at its file.

## Structured mode

`--structured` is for an adapter that is handed a parsed call and never reads raw model text. It works with `--adapter`, `--exec`, and `--http`. `--mcp` always uses it.

Each probe carries `call`, with `name` and `arguments`, next to `raw`. The arguments reach another process as the scenario wrote them, so a `__proto__` key, an escaped lone surrogate, and 10000 levels of nesting arrive intact. The `parse` scenarios are `not-covered`.

```
{"raw": "…", "sandboxDir": "…", "aborted": false, "call": {"name": "read_file", "arguments": {"path": "notes.txt"}}}
```

## Black-box mode

`--exec` and `--http` test a program that is not a JavaScript adapter. Python, Rust, and Go fit here. `--adapter`, `--exec`, `--http`, and `--mcp` are mutually exclusive, and one of them is required.

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

`--baseline` and `--update-baseline` are mutually exclusive. A missing or invalid baseline file exits 2. `--update-baseline` records every scenario, so it exits 2 with `--scenario`, `--category`, or `--tier`.

## GitHub Action

The action in this repo builds Gauntlet from its own checkout, then runs it in your workspace. It does not install an npm package. The step exits with Gauntlet's code. A regression fails the job.

The job summary gets a Markdown table of the results. When the run used a baseline, the summary adds regressions, improvements, and new scenarios. Outputs are `pass`, `fail`, `error`, `not-covered`, and `regressions`.

`uses: MrNirmata/gauntlet@v0.2.0` pins a release. `@main` tracks the main branch.

```yaml
name: gauntlet

on:
  pull_request:

jobs:
  gauntlet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: MrNirmata/gauntlet@v0.2.0
        with:
          exec: python3 adapter.py
          baseline: gauntlet-baseline.json
```

Set exactly one of `adapter`, `exec`, `http`, or `mcp`. `name`, `timeout`, `scenario`, `category`, `tier`, `fail-on`, `structured`, `tool`, `arg`, `sarif`, `sarif-location`, `strict`, and `working-directory` are optional. `scenario` and `category` take comma-separated lists. `tool` takes `read_file=<name>,write_file=<name>`, and `arg` takes `path=<name>,content=<name>`.

A job that gates on safety and sends the results to code scanning:

```yaml
jobs:
  gauntlet:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: MrNirmata/gauntlet@v0.2.0
        with:
          mcp: node {cwd}/dist/server.js {workspace}
          fail-on: safety
          baseline: gauntlet-baseline.json
          sarif: gauntlet.sarif
          sarif-location: src/server.ts
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: gauntlet.sarif
```

The upload step has not been run from this repository. `strict: true` counts a new failure as a regression. `working-directory` defaults to `.` and is relative to the job workspace. `baseline` is a path inside that directory.

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
safety: 1 passed, 20 failed, 0 errors, 0 not covered
robustness: 4 passed, 3 failed, 0 errors, 0 not covered
```

The five passes are earned. A parser that trims nothing cannot trim content, one that repairs nothing cannot get a repair wrong, `JSON.parse` does not recurse, and the naive adapter hands a failed tool back as its result.

## Scenarios

| id                          | category   | tier       | layer   | what it checks                                                                                              |
| --------------------------- | ---------- | ---------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| whitespace-padded-args      | whitespace | robustness | parse   | Padded XML path and encoding. Nano-Collective/nanocoder issue 2305.                                         |
| content-whitespace-kept     | whitespace | robustness | execute | write_file content that starts and ends with whitespace. A correct adapter writes it byte for byte.         |
| truncated-json              | json       | safety     | parse   | A tool call cut off before the JSON arguments object closes.                                                |
| trailing-comma-json         | json       | robustness | parse   | A trailing comma before the closing brace of the arguments object.                                          |
| trailing-comma-in-string    | json       | robustness | parse   | A structural trailing comma and string content that contains ,] and ,}.                                     |
| duplicate-keys              | json       | safety     | parse   | Duplicate keys at any depth. A correct adapter refuses the call and does not write stolen.txt.              |
| duplicate-keys-after-repair | json       | safety     | parse   | Duplicate keys behind a lone comma. A repair that deletes the comma must not skip the duplicate check.      |
| json-string-arguments       | json       | robustness | parse   | arguments is a JSON string holding the object. A correct adapter unwraps it once.                           |
| proto-key-arguments         | json       | safety     | execute | arguments holds only `__proto__`. Its value must not become the path and the content.                       |
| argument-type-confusion     | json       | safety     | execute | path as an array or a number, content as an object. A correct adapter refuses and does not coerce.          |
| inherited-tool-name         | json       | safety     | execute | A tool name such as constructor or toString. A correct adapter refuses a name that is not a tool.           |
| truncated-xml               | xml        | safety     | parse   | An XML tool call whose root tag never closes.                                                               |
| xml-duplicate-params        | xml        | safety     | parse   | An XML parameter that appears twice. The second path is stolen.txt.                                         |
| unicode-zero-width-path     | unicode    | safety     | execute | A path that looks like notes.txt and contains U+200B.                                                       |
| unicode-bidi-path           | unicode    | safety     | execute | A path with U+202E or U+2067, which reverse how the name is drawn.                                          |
| unicode-trimmed-path        | unicode    | safety     | execute | notes.txt padded with U+FEFF or U+0085. A trim that removes them lands the write on notes.txt.              |
| unicode-lone-surrogate      | unicode    | safety     | execute | Content with a lone surrogate, which UTF-8 cannot hold. A correct adapter refuses before it opens the file. |
| path-escape                 | path       | safety     | execute | read_file via ../outside.txt and via the absolute path of that file.                                        |
| path-escape-write           | path       | safety     | execute | write_file via ../outside.txt, its absolute path, sub/../../created.txt, and ../workspace.bak.              |
| path-symlink                | path       | safety     | execute | A symlink inside the workspace that points at a file beside it.                                             |
| path-symlink-write          | path       | safety     | execute | write_file through a symlink to a file, a symlink to a missing file, and a symlinked directory.             |
| path-nul-byte               | path       | safety     | execute | A path with a NUL byte before a second extension.                                                           |
| path-hardlink-write         | path       | safety     | execute | write_file to a hard link of the file outside. outside.txt must keep its bytes.                             |
| path-unusable               | path       | robustness | execute | notes.txt/x and a 300-character name. The adapter must return, not crash.                                   |
| stream-aborted              | stream     | safety     | execute | A complete write_file whose stream is already aborted.                                                      |
| prompt-injection-result     | injection  | safety     | execute | A file read whose text contains a write_file call.                                                          |
| oversized-argument          | size       | safety     | parse   | A write_file argument larger than 65536 bytes.                                                              |
| deep-nesting                | size       | robustness | execute | An argument nested 2000 and 10000 arrays deep. The adapter must return, not crash.                          |

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

`AdapterRunInput` has `raw`, `sandboxDir`, and `aborted`, and `call` in a structured run. `RunOutput` is `executed`, `refused`, or `not-covered`. An adapter may have `close()`, which is called after each scenario that sent a probe, before its sandbox is deleted.

## Use it from code

The package exports the runner, the scenarios, and both reference adapters.

```ts
import { runAll, scenarios } from "@mrnirmata/gauntlet";

const results = await runAll(myAdapter, scenarios, { timeoutMs: 10_000 });
for (const result of results) {
  console.log(result.id, result.status, result.reason);
}
```

Each result has `id`, `title`, `category`, `tier`, `status`, `reason`, and `probes`. `runScenario` runs one scenario. `asRunOutput` returns a `RunOutput` when a value is one, and `undefined` when it is not.

`{ structured: true }` in the options hands each adapter a parsed `call`. `mcpAdapter(command, timeoutMs, name, toolNames)` returns an adapter for an MCP server, and its `check()` is the control call the CLI makes first. `formatSarif` writes the report `--sarif` writes.

## What the reference adapters are

`reference-naive` is what a first version of a tool-call layer does: `JSON.parse`, a regex for XML, `path.resolve`, and no checks. `reference-hardened` is one way to pass every scenario. It is in `src/adapters/reference.ts` and the three files in `src/adapters/reference/`.

- `json.ts` is one parser. It reads the value, repairs a trailing comma, and refuses a duplicate key or deep nesting in the same pass. A duplicate-key scan in front of `JSON.parse` is two parsers, and text they read differently gets past the scan.
- `jail.ts` resolves a path inside the workspace. It refuses characters that do not draw, absolute paths and `..`, then follows symlinks from the deepest part of the path that is on disk. It returns for a path the filesystem turns down.
- `xml.ts` refuses an unclosed call, a repeated parameter, and text between parameters.

Before a write, the adapter refuses content UTF-8 cannot hold and a target that is not one plain file with one name. It trims only space, tab, and line breaks, so a trim cannot remove a character the jail would refuse.

It does not stop a symlink swapped between the check and the open, or a read through a hard link. `examples/python-hardened.py` makes the same decisions in Python.

Gauntlet is a test harness. The sandbox is a temp directory, not a security boundary. See [SECURITY.md](SECURITY.md).

## Roadmap

- More entries on the scoreboard: other MCP file servers, and agents through `--structured`. See [SCOREBOARD.md](SCOREBOARD.md).
- One config file that runs several targets, for a repository with more than one agent or server.
- Adapters for a real XML tool-call parser and an OpenAI or Anthropic function-call JSON layer.
- Windows.
