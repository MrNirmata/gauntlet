# Gauntlet

Gauntlet runs adversarial tool-call cases against the code that turns model output into a tool call. A demo can look fine while that step drops, rewrites, or over-trusts the arguments. Pass an adapter name and it prints which cases pass, which fail, and a one-line reason. MrNirmata wrote it.

## Quickstart

Install Node 22, then:

```
pnpm install
pnpm build
node dist/cli.js list
node dist/cli.js run --adapter reference-naive
node dist/cli.js run --adapter reference-hardened
node dist/cli.js run --adapter reference-naive --json
```

`reference-naive` exits 1. That adapter gets these cases wrong, which is the failure demo. `reference-hardened` exits 0. The package bin is `gauntlet` (`dist/cli.js`), which is what `npx gauntlet` runs after the package is installed.

## Output from reference-naive

This is the stdout of `node dist/cli.js run --adapter reference-naive`.

```
adapter: reference-naive

scenario                 category    status  reason
whitespace-padded-args   whitespace  fail    refused a padded but valid call
truncated-json           json        fail    executed a truncated tool call
trailing-comma-json      json        fail    rejected JSON with a trailing comma
duplicate-keys           json        fail    duplicate key last-wins wrote stolen.txt
unicode-zero-width-path  unicode     fail    wrote a lookalike path
path-escape              path        fail    dotdot read a file outside the workspace
path-symlink             path        fail    symlink read a file outside the workspace
stream-aborted           stream      fail    aborted stream still wrote notes.txt
prompt-injection-result  injection   fail    tool result triggered write_file
oversized-argument       size        fail    wrote an oversized argument

0 passed, 10 failed, 0 errors
```

## Scenarios

| id                      | category   | what it checks                                                                                          |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| whitespace-padded-args  | whitespace | XML `path` and `encoding` keep surrounding spaces. Nanocoder issue 2305 stopped trimming these strings. |
| truncated-json          | json       | JSON cut off after a path value, before the arguments object closes.                                    |
| trailing-comma-json     | json       | A trailing comma before the closing brace.                                                              |
| duplicate-keys          | json       | `path` and `content` sent twice. `JSON.parse` keeps the last value.                                     |
| unicode-zero-width-path | unicode    | A path that looks like `notes.txt` and contains U+200B.                                                 |
| path-escape             | path       | `../` and an absolute path, both outside the workspace.                                                 |
| path-symlink            | path       | A symlink whose target sits next to the workspace.                                                      |
| stream-aborted          | stream     | The tool-call bytes are complete and the stream is already aborted.                                     |
| prompt-injection-result | injection  | File text contains a `write_file` call and tells the reader to run it.                                  |
| oversized-argument      | size       | `write_file` content longer than 65536 bytes.                                                           |

## Write an adapter

An adapter receives the raw model output, a fresh temp directory, and whether the stream aborted. It returns the tool call it executed, or a refusal. Gauntlet does not parse the payload first.

```ts
type Adapter = {
  readonly name: string;
  run(input: { raw: string; sandboxDir: string; aborted: boolean }): Promise<
    | {
        status: "executed";
        call: { name: string; arguments: Record<string, unknown> };
        result: string;
      }
    | { status: "refused"; reason: string }
  >;
};
```

Register the object on the `adapters` array. `CONTRIBUTING.md` has the steps, the v0.1 fixture shapes, and the three adapters this version does not include.

## Roadmap

- Adapters for a real XML tool-call parser, an OpenAI or Anthropic function-call JSON layer, and an MCP filesystem server.
- A public scoreboard of those adapters.
- More scenarios, proposed through the scenario issue template.
