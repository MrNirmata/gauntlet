# Changelog

## Unreleased

New scenarios. The suite goes from 12 to 22. A baseline recorded before this lists them as new. They do not fail a `--baseline` run unless `--strict` is set.

- duplicate-keys-after-repair
- proto-key-arguments
- argument-type-confusion
- truncated-xml
- xml-duplicate-params
- unicode-bidi-path
- path-escape-write
- path-symlink-write
- path-nul-byte
- deep-nesting

Fixes in `reference-hardened`. Each was a way through an adapter that passed all 12 scenarios.

- Refuse duplicate keys behind a lone comma. `{"x":{,},"arguments":{"path":"notes.txt","path":"stolen.txt"}}` stopped the duplicate-key scan, the trailing-comma repair deleted the comma, and `JSON.parse` kept the last `path`. One parser now reads the value and checks it.
- Refuse a write through a symlink whose target does not exist. The write created the file outside the workspace.
- Refuse deep nesting. 20000 nested arrays overflowed the stack of the duplicate-key scan and the adapter threw.
- Refuse a path with a control character. A NUL byte reached `fs` and the adapter threw.
- Refuse the soft hyphen, bidi marks, and invisible operators in a path, not only the zero-width characters.
- Refuse an XML call with a repeated parameter or text between parameters.
- Report a failed read or write as the tool result. The adapter does not throw.

Runner and CLI:

- Add `gauntlet show <id>`, which prints a scenario and the payloads it sends.
- Add `--verbose`, which prints every payload and output of a scenario that did not pass. With `--json` it adds `probes` to each scenario.
- Add `--category <name>`. `--scenario` and `--category` repeat and take comma-separated lists.
- Add `--junit <file>` for a JUnit XML report.
- Add `gauntlet help`, `--help`, `--version`, and `gauntlet list --json`.
- Apply `--timeout` to a module adapter. A `run` that does not settle is an error, not a hang.
- Check what a module adapter returns. A value that is not a `RunOutput` is an error with that reason.
- Stop reading `--exec` and `--http` output at 4 MiB.
- Copy `call.arguments` as own properties. A `__proto__` key in an adapter's reply no longer becomes the prototype of the copy.
- `Scenario` has a required `expected` line and an optional `setup` line. `Result` has `probes`.

Examples:

- Add `examples/python-hardened.py`, which passes every scenario from Python.
- `examples/python-adapter.py` refuses a NUL byte and deep nesting. It exited 1 with a traceback on both.

Earlier in this release:

- Add a GitHub Action that builds Gauntlet from the checkout and writes the run to the job summary.
- Compare a run with `--baseline` and record the current results with `--update-baseline`.
- Run a program that is not a JavaScript adapter with `--exec <command>` or `--http <url>`.
- Load a user adapter from a file with `gauntlet run --adapter <path>`.
- Export `defineAdapter` so an adapter module can be typechecked.

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
