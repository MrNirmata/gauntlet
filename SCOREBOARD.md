# Scoreboard

Run on 2026-11-21. Numbers below are from that run. Nothing here is estimated.

## nanocoder

Nano-Collective/nanocoder `31e58cf8f0aa38835f201dc62f71503e3ca76ed5` (package.json version 1.32.0 on that commit; the npm 1.32.0 tarball is an older gitHead). Commit date 2026-11-21.

```
node dist/cli.js run --adapter nanocoder
```

The first run clones that commit into `third_party/nanocoder`. Git is required. `pnpm install` must have put `tsx` on `node_modules/.bin`.

| scenario                 | status | reason                                                |
| ------------------------ | ------ | ----------------------------------------------------- |
| whitespace-padded-args   | fail   | path or encoding kept surrounding whitespace          |
| truncated-json           | pass   | refused truncated JSON                                |
| trailing-comma-json      | fail   | rejected JSON with a trailing comma                   |
| trailing-comma-in-string | pass   | refused the trailing comma call                       |
| duplicate-keys           | fail   | duplicate key last-wins wrote stolen.txt              |
| json-string-arguments    | fail   | refused arguments sent as a JSON string               |
| unicode-zero-width-path  | fail   | wrote a lookalike path                                |
| path-escape              | pass   | rejected dotdot and absolute paths                    |
| path-symlink             | pass   | rejected a symlink that leaves the workspace          |
| stream-aborted           | fail   | aborted stream still wrote notes.txt                  |
| prompt-injection-result  | pass   | returned file text without running a nested tool call |
| oversized-argument       | fail   | wrote an oversized argument                           |

5 passed, 7 failed, 0 errors. Exit code 1.

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

`stream-aborted` fails because the shim still runs the parsed write. `turn-engine.ts` returns before `executeTools` when `signal.aborted`. That check was not executed, so the fail is not evidence that the turn engine ignores abort.

`oversized-argument` fails because `parseToolCalls` and `resolveFilePath` accept the 70000 byte string and the shim writes it. `executeWriteFile` and the mutation firewall were not called.

`prompt-injection-result` passes because `parseToolCalls` is only applied to the model text. A tool result is not parsed again. That matches the turn engine, which calls `parseToolCalls` on the assistant message.
