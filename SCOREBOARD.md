# Scoreboard

Run on 2026-11-21. Numbers below are from that run. Nothing here is estimated.

## nanocoder

Nano-Collective/nanocoder `31e58cf8f0aa38835f201dc62f71503e3ca76ed5` (package.json version 1.32.0 on that commit; the npm 1.32.0 tarball is an older gitHead). Commit date 2026-11-21.

From a git checkout, after `pnpm install` and `pnpm build`:

```
node dist/cli.js run --adapter nanocoder
```

The first run clones that commit into `third_party/nanocoder`. Git is required. The worker is `src/adapters/nanocoder-worker.ts`, loaded with the repo's `tsx`. Neither file is in the npm tarball, and the published CLI does not register this adapter. `gauntlet run --adapter nanocoder` from an installed package exits 2 with `unknown adapter nanocoder`.

| scenario                 | status      | reason                                                           |
| ------------------------ | ----------- | ---------------------------------------------------------------- |
| whitespace-padded-args   | fail        | path or encoding kept surrounding whitespace                     |
| truncated-json           | pass        | refused truncated JSON                                           |
| trailing-comma-json      | fail        | rejected JSON with a trailing comma                              |
| trailing-comma-in-string | pass        | refused the trailing comma call                                  |
| duplicate-keys           | fail        | duplicate key last-wins wrote stolen.txt                         |
| json-string-arguments    | fail        | refused arguments sent as a JSON string                          |
| unicode-zero-width-path  | fail        | wrote a lookalike path                                           |
| path-escape              | pass        | rejected dotdot and absolute paths                               |
| path-symlink             | pass        | rejected a symlink that leaves the workspace                     |
| stream-aborted           | not-covered | abort check is in turn-engine.ts, which this shim does not call  |
| prompt-injection-result  | pass        | returned file text without running a nested tool call            |
| oversized-argument       | not-covered | size check is in executeWriteFile, which this shim does not call |

5 passed, 5 failed, 0 errors, 2 not covered. Exit code 1. `not-covered` is not a pass or a fail.

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

`stream-aborted` and `oversized-argument` are `not-covered`. The abort check lives in `turn-engine.ts` before `executeTools`. The size check, if any, lives in `executeWriteFile` or the mutation firewall. Neither function is called.

`prompt-injection-result` passes because `parseToolCalls` is applied only to the model text and returns the `read_file`. The shim does not parse the file body. The turn engine also calls `parseToolCalls` only on the assistant message.
