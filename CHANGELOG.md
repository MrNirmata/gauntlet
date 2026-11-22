# Changelog

## Unreleased

New scenarios. The suite goes from 12 to 28. A baseline recorded before this lists them as new. They do not fail a `--baseline` run unless `--strict` is set.

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

Fixes in `reference-hardened`. Each was a way through an adapter that passed all 12 scenarios.

- Refuse duplicate keys behind a lone comma. `{"x":{,},"arguments":{"path":"notes.txt","path":"stolen.txt"}}` stopped the duplicate-key scan, the trailing-comma repair deleted the comma, and `JSON.parse` kept the last `path`. One parser now reads the value and checks it.
- Refuse a write through a symlink whose target does not exist. The write created the file outside the workspace.
- Refuse deep nesting. 20000 nested arrays overflowed the stack of the duplicate-key scan and the adapter threw.
- Refuse a path with a control character. A NUL byte reached `fs` and the adapter threw.
- Refuse every control, format, private-use, and unassigned character in a path, every space that is not U+0020, and the blank fillers and variation selectors. The list was 14 code points.
- Trim only space, tab, and line breaks. `trim()` removed U+FEFF before the path check, so a path of U+FEFF and `notes.txt` read `notes.txt`.
- Return for a path the filesystem turns down. `notes.txt/x`, a 300-character name, a link loop, and a directory without permission made the jail throw.
- Refuse a path that goes through a file.
- Refuse content with a lone surrogate. Node wrote U+FFFD in its place.
- Refuse a write to a FIFO, a directory, or a file with a second hard link.
- Accept `UTF-8` and `utf8` as the encoding.
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
- Settle an `--exec` probe at the limit. It waited for the pipes to close, so a grandchild holding stdout held the probe for as long as it lived.
- Kill the process group of an `--exec` command when the command exits. What it started in the background kept running after the probe.
- Keep running when a sandbox cannot be deleted. A directory an adapter left without permissions ended the run with a stack trace and no report.
- Judge the other probes when one is not covered. A write outside the workspace on one probe was hidden by a `not-covered` on the next.
- Exit 2 for `--update-baseline` with `--scenario` or `--category`. It replaced the whole baseline with the filtered run.
- Exit 2 for an empty `--scenario` or `--category`, a `--timeout` above 2147483647, and an `--http` value that is not an http or https URL.
- Escape control characters in a reason, an adapter name, and a tool name. An adapter could clear the screen or draw a row.
- Flush stdout before exit. A `--json` report over 64 KiB was cut when stdout was a pipe.
- Escape `_`, `*`, and the backslash in the job summary, so `__proto__` is not bold.
- Refuse `NaN` and `Infinity` in the arguments a module adapter returns. A JSON report printed them as `null`.
- Build on `prepare`, so an install from git has `dist`.
- The action takes `category`. `scenario` takes a list.

Scenario checks that were too loose or too tight:

- `path-escape-write` also writes `../workspace.bak`. A jail that compares path prefixes without a separator passed every path scenario.
- `prompt-injection-result` requires the text of the file in the result. An empty result passed.
- `path-symlink-write` accepts an adapter that replaces the link with a new file. It only accepted a refusal.
- `duplicate-keys` names first-wins when `notes.txt` is what changed.
- `trailing-comma-json` requires the call to be `read_file`.

The version is `0.2.0-dev` until the release. `gauntletVersion` in a report and in a baseline no longer says 0.1.1 for a build with 28 scenarios.

Examples:

- Add `examples/python-hardened.py`, which passes every scenario from Python.
- `examples/python-adapter.py` refuses a NUL byte and deep nesting. Before this it exited 1 with a traceback on both. It encodes content before it opens the file. Content with a lone surrogate emptied `notes.txt` and the reply said refused.

A second pass reviewed the runner, the CLI, the scenario checks, and the tests. The runner and CLI fixes from the exec limit down, and the four scenario checks above, came from it.

An independent pass attacked both hardened adapters after the first 22 scenarios. It found no way out of the workspace without a race or a hard link, and no text the strict parser and `JSON.parse` read differently. The fixes above from U+FEFF down, the four scenarios `unicode-trimmed-path`, `unicode-lone-surrogate`, `path-hardlink-write`, and `path-unusable`, and the second depth in `deep-nesting` came from it.

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
