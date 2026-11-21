# Changelog

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
