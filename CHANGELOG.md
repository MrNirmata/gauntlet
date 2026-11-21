# Changelog

## Unreleased

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
