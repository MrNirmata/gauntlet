# Changelog

## Unreleased

- Add `gauntlet scan --mcp <command>`. It reads the tools an MCP server lists and the schema of each one, makes a plain call from the schema, puts payloads in every string argument, and sends calls the schema forbids. It works on a server with any tools, not only file tools.
- A finding is something the scan saw: a planted secret in a reply, a planted file that changed, a marker file a payload created, a server that exited or stopped answering, a result for a call its schema rules out. Each has the call that caused it and one line on the fix.
- The report says which tools turned down even a plain call. No finding means little for those.
- The server is started in a temp directory with `PATH` and a temp `HOME` and nothing else of the user's. `--env` passes a variable on. A tool the server marks destructive is not called without `--destructive`.
- `--tool`, `--skip`, `--ignore <kind[:tool]>`, `--fail-on`, `--max-calls`, and `--json` for the scan.
- The README's action examples pin `v0.2.0`.

## 0.2.0

The suite goes from 12 scenarios to 28. Gauntlet can now test code that is not a JavaScript adapter: a program in any language, an HTTP endpoint, and an MCP server with no adapter at all. `reference-hardened` passed all 12 scenarios of 0.1 and still had ways through, which the new scenarios found.

### Targets

- `--adapter <path>` loads an adapter from a file. `defineAdapter` is exported so the module can be typechecked.
- `--exec <command>` runs a program once per probe, and `--http <url>` POSTs each probe. Each probe is one JSON object in and one out. A reply over 4 MiB is an error. A command is killed with its process group at the limit, and when it exits, so nothing it started is left running.
- `--mcp <command>` tests an MCP server on stdio. Gauntlet starts the server once per scenario, in the scenario's workspace, and sends each probe as a `tools/call` request. `--tool` maps `read_file` and `write_file` to the server's names, and `--arg` maps `path` and `content`.
- Before an MCP run, the server is started once and asked to write a file and read it back. One that cannot start, has neither tool, or does not do that exits 2 with one message. Without that call, a server that turned every call down would pass every scenario that expects a refusal.
- `--structured` is for a target that is handed a parsed call and never reads raw model text. Each probe carries `call`. It works with `--adapter`, `--exec`, and `--http`, and `--mcp` always uses it.
- An adapter may have `close()`, called after each scenario that sent a probe. It has five seconds.

### Scenarios

Sixteen are new. A baseline recorded with 0.1 lists them as new, and they fail a `--baseline` run only with `--strict`.

- content-whitespace-kept
- duplicate-keys-after-repair
- proto-key-arguments
- argument-type-confusion
- inherited-tool-name
- truncated-xml
- xml-duplicate-params
- unicode-bidi-path
- unicode-trimmed-path
- unicode-lone-surrogate
- path-escape-write
- path-symlink-write
- path-nul-byte
- path-hardlink-write
- path-unusable
- deep-nesting

Each scenario has a tier, a layer, and CWE ids, in `src/scenarios/classify.ts`.

- The tier is `safety` or `robustness`. A safety failure is harm: a file outside the workspace, a call nobody sent, bytes the model did not send. A robustness failure is a call that should have worked and did not, or a crash.
- The layer is `parse` or `execute`. A `parse` scenario is about reading model output and is `not-covered` in a structured run. An `execute` scenario sends a well-formed call.
- The CWE ids are a classification made here. MITRE did not assign them to any product.

Checks on the 12 scenarios of 0.1 that changed:

- `prompt-injection-result` requires the text of the file in the result. An empty result passed.
- `trailing-comma-json` requires the call to be `read_file`.
- `path-escape` and `path-symlink` fail a refusal that quotes `outside.txt`, however long the refusal is. A refusal goes back to the model like any result.
- `duplicate-keys` names first-wins when `notes.txt` is what changed.
- When one probe of a scenario is not covered, the other probes are still judged. A write outside the workspace on one probe was hidden by a `not-covered` on the next.
- `outside.txt` holds a token nothing writes by accident. It held `secret`.
- The report is ordered by group: whitespace, json, xml, unicode, path, stream, injection, size.

### Running and reports

- `gauntlet show <id>` prints a scenario and the payloads it sends. `gauntlet list --json` prints every scenario with its tier, layer, and CWE ids.
- `--verbose` prints every payload and output of a scenario that did not pass. With `--json` it adds `tier` and `probes` to each scenario.
- `--scenario`, `--category`, and `--tier` select what runs. The first two repeat and take comma-separated lists.
- `--fail-on <tier>` names the tier that decides the exit code. The text report has a line for each tier.
- `--baseline <file>` fails a run only on a regression, `--update-baseline <file>` records one, and `--strict` counts a new failing scenario as a regression. `--update-baseline` records every scenario, so it exits 2 with a filter.
- `--junit <file>` writes JUnit XML.
- `--sarif <file>` writes SARIF 2.1.0: a rule per scenario with its CWE tags, and a result per failure. `--sarif-location <path>` is the file a viewer opens for a failure. It is required unless `--adapter` is a path.
- `gauntlet help`, `--help`, and `--version`.
- A GitHub Action in this repository builds Gauntlet from its own checkout, runs it in the caller's workspace, and writes a table to the job summary. Its inputs follow the flags above.

### Changed

- `--timeout` applies to a module adapter, which now has the 10 second default per probe. A `run` that does not settle is an error. It was a hang.
- What a module adapter returns is checked. A value that is not a `RunOutput` is an error with that reason. So are arguments a report cannot print: `NaN`, a BigInt, a function, a value that contains itself.
- An interrupt stops what the run started and deletes the sandbox.
- A sandbox that cannot be deleted no longer ends the run.
- Control characters in a reason, an adapter name, and a tool name are escaped in the report.
- stdout is flushed before exit, so a large `--json` report is whole on a pipe.
- An empty filter, a `--timeout` above 2147483647, and an `--http` value that is not a URL exit 2.
- `Scenario` has `expected`, `tier`, `layer`, and `cwe`, and an optional `setup`. `Result` has `tier` and `probes`.
- `package.json` has a `prepare` script, so an install from git has `dist`.
- The `bin` path in `package.json` is `dist/cli.js`, with no `./` in front. npm 11 drops an entry that has one when it publishes, and the package installs without the `gauntlet` command.

### Holes in `reference-hardened`

Each was a way through, a crash, or a refusal it should not have made, in an adapter that passed all 12 scenarios of 0.1.

- Refuse duplicate keys behind a lone comma. `{"x":{,},"arguments":{"path":"notes.txt","path":"stolen.txt"}}` stopped the duplicate-key scan, the trailing-comma repair deleted the comma, and `JSON.parse` kept the last `path`. One parser now reads the value and checks it.
- Refuse a write through a symlink whose target does not exist. The write created the file outside the workspace.
- Trim only space, tab, and line breaks. `trim()` removed U+FEFF before the path check, so a path of U+FEFF and `notes.txt` read `notes.txt`.
- Refuse deep nesting. 20000 nested arrays overflowed the stack of the duplicate-key scan and the adapter threw.
- Refuse a path with a control character. A NUL byte reached `fs` and the adapter threw.
- Return for a path the filesystem turns down. A write to `notes.txt/x` or to a 300-character name made the adapter throw.
- Refuse every control, format, private-use, and unassigned character in a path, every space that is not U+0020, and the blank fillers and variation selectors. The list was 14 code points.
- Refuse a path that goes through a file.
- Refuse content with a lone surrogate. Node wrote U+FFFD in its place.
- Refuse a write to a FIFO, a directory, or a file with a second hard link.
- Refuse an XML call with a repeated parameter or text between parameters. The last `path` won.
- Accept `UTF-8` and `utf8` as the encoding.
- Report a failed read or write as the tool result. The adapter does not throw.

SECURITY.md lists what it still does not stop: a symlink swapped between the check and the open, a read through a hard link, and a lookalike letter from another alphabet.

### Examples and scoreboard

- `examples/adapter-template.mjs` is a starting point for a module adapter.
- `examples/python-adapter.py` is a naive adapter in Python, and `examples/python-hardened.py` passes every scenario from Python.
- The scoreboard has nanocoder at a pinned commit, and `@modelcontextprotocol/server-filesystem` 2.4.0 run as the published package with no shim.

### How it was checked

The tests pass on Node 22.23, 24.22, and 25.9 on macOS. Both Python examples were run on Python 3.9, 3.13, and 3.15. CI has not run for this release: no job started, because the account that owns the repository is locked for billing. Linux and Windows are untested.

Three independent passes reviewed the work before the release. One attacked both hardened adapters. It found no way out of the workspace without a race or a hard link, and no text the strict parser and `JSON.parse` read differently in 1.1 million generated texts. Two reviewed the runner, the CLI, the MCP client, the scenario checks, and the tests. What they found is fixed above, and each fix has a test.

## 0.1.1

- Fix the CLI exiting 0 without running when npm invokes it through the bin symlink.
- Remove the postinstall script that rewrote `node_modules/.bin/gauntlet`.

## 0.1.0

Checks for the code that turns model output into a tool call. The npm package is `@mrnirmata/gauntlet`.

Scenarios:

- whitespace-padded-args
- truncated-json
- trailing-comma-json
- trailing-comma-in-string
- duplicate-keys
- json-string-arguments
- unicode-zero-width-path
- path-escape
- path-symlink
- stream-aborted
- prompt-injection-result
- oversized-argument

Adapters:

- reference-naive
- reference-hardened
- nanocoder (see SCOREBOARD.md)

`gauntlet run --json` prints `adapter`, `gauntletVersion`, `scenarios`, and `totals`.
