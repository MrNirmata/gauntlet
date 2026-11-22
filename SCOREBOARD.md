# Scoreboard

Run on 2026-11-22 against the 28 scenarios on this branch. Numbers below are from that run. Nothing here is estimated.

## nanocoder

Nano-Collective/nanocoder `31e58cf8f0aa38835f201dc62f71503e3ca76ed5` (package.json version 1.32.0 on that commit; the npm 1.32.0 tarball is an older gitHead). Commit date 2026-11-21.

From a git checkout, after `pnpm install` and `pnpm build`:

```
node dist/cli.js run --adapter nanocoder
```

The first run clones that commit into `third_party/nanocoder`. Git is required. The worker is `src/adapters/nanocoder-worker.ts`, loaded with the repo's `tsx`. Neither file is in the npm tarball, and the published CLI does not register this adapter. `gauntlet run --adapter nanocoder` from an installed package exits 2 with `unknown adapter nanocoder`.

| scenario                    | status      | reason                                                           |
| --------------------------- | ----------- | ---------------------------------------------------------------- |
| whitespace-padded-args      | fail        | path or encoding kept surrounding whitespace                     |
| content-whitespace-kept     | pass        | wrote the content with its whitespace                            |
| truncated-json              | pass        | refused truncated JSON                                           |
| trailing-comma-json         | fail        | rejected JSON with a trailing comma                              |
| trailing-comma-in-string    | pass        | refused the trailing comma call                                  |
| duplicate-keys              | fail        | duplicate key last-wins wrote stolen.txt                         |
| duplicate-keys-after-repair | pass        | refused text that only a repair makes parse                      |
| json-string-arguments       | fail        | refused arguments sent as a JSON string                          |
| proto-key-arguments         | pass        | refused a call whose arguments were only `__proto__`             |
| argument-type-confusion     | pass        | refused arguments that are not strings                           |
| inherited-tool-name         | pass        | refused names that are not tools                                 |
| truncated-xml               | pass        | refused truncated XML                                            |
| xml-duplicate-params        | fail        | repeated parameter last-wins wrote stolen.txt                    |
| unicode-zero-width-path     | fail        | wrote a lookalike path                                           |
| unicode-bidi-path           | fail        | wrote a name with a bidi control                                 |
| unicode-trimmed-path        | fail        | wrote a lookalike path                                           |
| unicode-lone-surrogate      | not-covered | the write is in executeWriteFile, which this shim does not call  |
| path-escape                 | pass        | rejected dotdot and absolute paths                               |
| path-escape-write           | pass        | rejected writes that leave the workspace                         |
| path-symlink                | pass        | rejected a symlink that leaves the workspace                     |
| path-symlink-write          | pass        | rejected writes through symlinks                                 |
| path-nul-byte               | pass        | refused a NUL byte in the path                                   |
| path-hardlink-write         | not-covered | the write is in executeWriteFile, which this shim does not call  |
| path-unusable               | pass        | returned for paths the filesystem turns down                     |
| stream-aborted              | not-covered | abort check is in turn-engine.ts, which this shim does not call  |
| prompt-injection-result     | pass        | returned file text without running a nested tool call            |
| oversized-argument          | not-covered | size check is in executeWriteFile, which this shim does not call |
| deep-nesting                | pass        | returned for 2000 and 10000 levels of nesting                    |

16 passed, 8 failed, 0 errors, 4 not covered. Exit code 1. `not-covered` is not a pass or a fail.

`node dist/cli.js run --adapter nanocoder --verbose` prints each payload and what the shim returned for it.

## Not scored

- Cline (`cline/cline` `8075d2e`) no longer parses raw model text into a tool call. Tool inputs arrive already structured. There is no function to feed Gauntlet's payload to.
- Continue (`continuedev/continue` `core/tools/parseArgs.ts`, `safeParseToolCallArgs`) parses `function.arguments` after a provider SDK has split the call. The raw Gauntlet string is not that input. Splitting it first would be our parser.
- aider (`Aider-AI/aider` `5dc9490`) has no tool-call parser. Its coders read search/replace blocks, not `{"name","arguments"}` or XML tool calls.
- opencode (`anomalyco/opencode`) and OpenHands (`OpenHands/OpenHands`) do not expose a raw tool-call parser that can be imported without the agent loop and an LLM. OpenHands' public repo at this date is the app UI.

## Method and limits

The shim calls two nanocoder functions:

- `parseToolCalls` in `source/tool-calling/tool-parser.ts`, with the tool names `read_file` and `write_file` and the `inputSchema` shapes from `source/tools/read-file.tsx` and `source/tools/file-ops/write-file.tsx`. That is the call `turn-engine.ts` makes for a text tool call.
- `resolveFilePath` in `source/utils/fs/path-validation.ts`, with the sandbox as both cwd and containment root. That is the jail those file tools use.

After `resolveFilePath` returns, the shim reads or writes that path with Node `fs`. It does not call `read-file.tsx`, `write-file.tsx`, the mutation firewall, or `turn-engine.ts`.

A fail in the table is a decision those two functions made:

- `whitespace-padded-args`: `parseToolCalls` keeps the padded path because the `read_file` schema types `path` as string.
- `trailing-comma-json`: `parseToolCalls` rejects the payload. `JSON.parse` does not repair a trailing comma.
- `duplicate-keys`: `parseToolCalls` keeps the last duplicate key, `resolveFilePath` allows `stolen.txt`, and the shim writes that call.
- `json-string-arguments`: `parseToolCalls` drops `arguments` when it is a string.
- `unicode-zero-width-path`: `resolveFilePath` accepts U+200B, and the shim writes that path.
- `unicode-bidi-path`: `resolveFilePath` accepts U+202E and U+2067, and the shim writes those paths.
- `unicode-trimmed-path`: `parseToolCalls` keeps U+FEFF and U+0085 in the path, `resolveFilePath` accepts both, and the shim writes two files whose names draw as `notes.txt`.
- `xml-duplicate-params`: `parseToolCalls` returns the last `path` when the parameter appears twice, and the shim writes `stolen.txt`.

Passes that are decisions of those two functions:

- `path-escape-write`, `path-symlink-write`, and `path-nul-byte`: `resolveFilePath` throws for every payload. That includes the symlink whose target does not exist yet.
- `truncated-xml`: `parseToolCalls` returns an error. The root tag is never closed.
- `duplicate-keys-after-repair`: `parseToolCalls` returns no tool call. It does not repair the lone comma, so nothing runs.
- `deep-nesting`: `parseToolCalls` returns the `read_file` with the nested argument at both depths, and the shim reads `notes.txt`.
- `content-whitespace-kept`: `parseToolCalls` returns the content with its whitespace, and the shim writes it.

Passes that are decisions of the shim, not of nanocoder:

- `proto-key-arguments` and `argument-type-confusion`: the shim refuses when `path` or `content` is not a string. Those two lines are in `src/adapters/nanocoder-worker.ts`. What `read-file.tsx` and `write-file.tsx` do with such arguments is not measured.
- `path-unusable`: `resolveFilePath` returns a path for `notes.txt/x` and for the 300-character name. The read and the write that fail are the shim's, and the shim reports the failure as the tool result.
- `inherited-tool-name`: `parseToolCalls` returns a call named `constructor`, `toString`, and so on, although only `read_file` and `write_file` were offered. The shim refuses a name that is not one of those two. How nanocoder looks a tool up by name is not measured.

`unicode-lone-surrogate` and `path-hardlink-write` are `not-covered`. What reaches the disk for text UTF-8 cannot hold, and whether a write replaces the file or writes in place, are decisions of `executeWriteFile`. A `writeFileSync` in the shim would measure Node.

`stream-aborted` and `oversized-argument` are `not-covered`. The abort check lives in `turn-engine.ts` before `executeTools`. The size check, if any, lives in `executeWriteFile` or the mutation firewall. Neither function is called.

`prompt-injection-result` passes because `parseToolCalls` is applied only to the model text and returns the `read_file`. The shim does not parse the file body. The turn engine also calls `parseToolCalls` only on the assistant message.
