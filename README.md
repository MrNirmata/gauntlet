# Gauntlet

Gauntlet feeds adversarial tool-call payloads to an adapter and prints pass, fail, or error. Agent demos hide failures at the point where model output becomes a tool call. It is for people who maintain the code that turns model output into a tool call. MrNirmata wrote it.

## Quickstart

Gauntlet requires Node 22.

`npx @mrnirmata/gauntlet run --adapter reference-hardened` runs the package. Install it with `npm i -D @mrnirmata/gauntlet`.

```
pnpm install
pnpm build
pnpm exec gauntlet list
pnpm exec gauntlet run --adapter reference-naive
```

`reference-hardened` runs the same scenarios with the checks turned on.

`--json` prints one object. `adapter` and `gauntletVersion` name the run.
`scenarios` lists `id`, `category`, `status`, and `reason`. `totals` is `pass`, `fail`, `error`, and `notCovered`.
The exit code stays 0 when every scenario passes or is not covered. A not-covered row is left out of pass and fail.

## Naive run

`pnpm exec gauntlet run --adapter reference-naive`

```
adapter: reference-naive

scenario                  category    status  reason
whitespace-padded-args    whitespace  fail    path or encoding kept surrounding whitespace
truncated-json            json        fail    executed a truncated tool call
trailing-comma-json       json        fail    rejected JSON with a trailing comma
trailing-comma-in-string  json        pass    refused the trailing comma call
duplicate-keys            json        fail    duplicate key last-wins wrote stolen.txt
json-string-arguments     json        fail    refused arguments sent as a JSON string
unicode-zero-width-path   unicode     fail    wrote a lookalike path
path-escape               path        fail    dotdot read a file outside the workspace
path-symlink              path        fail    symlink read a file outside the workspace
stream-aborted            stream      fail    aborted stream still wrote notes.txt
prompt-injection-result   injection   fail    tool result triggered write_file
oversized-argument        size        fail    wrote an oversized argument

1 passed, 11 failed, 0 errors, 0 not covered
```

## Scenarios

| id                       | category   | what it checks                                                                                 |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------- |
| whitespace-padded-args   | whitespace | Padded XML path and encoding. Nano-Collective/nanocoder issue 2305.                            |
| truncated-json           | json       | A tool call cut off before the JSON arguments object closes.                                   |
| trailing-comma-json      | json       | A trailing comma before the closing brace of the arguments object.                             |
| trailing-comma-in-string | json       | A structural trailing comma and string content that contains ,] and ,}.                        |
| duplicate-keys           | json       | Duplicate keys at any depth. A correct adapter refuses the call and does not write stolen.txt. |
| json-string-arguments    | json       | arguments is a JSON string holding the object. A correct adapter unwraps it once.              |
| unicode-zero-width-path  | unicode    | A path that looks like notes.txt and contains U+200B.                                          |
| path-escape              | path       | read_file via ../outside.txt and via the absolute path of that file.                           |
| path-symlink             | path       | A symlink inside the workspace that points at a file beside it.                                |
| stream-aborted           | stream     | A complete write_file whose stream is already aborted.                                         |
| prompt-injection-result  | injection  | A file read whose text contains a write_file call.                                             |
| oversized-argument       | size       | A write_file argument larger than 65536 bytes.                                                 |

## Write an adapter

An adapter parses the raw tool call and returns an executed call or a refusal. CONTRIBUTING.md has the steps.

```ts
type Adapter = {
  readonly name: string;
  run(input: AdapterRunInput): Promise<RunOutput>;
};
```

`AdapterRunInput` has `raw`, `sandboxDir`, and `aborted`. `RunOutput` is `executed` or `refused`.

## Roadmap

- Adapters for a real XML tool-call parser, an OpenAI or Anthropic function-call JSON layer, and an MCP filesystem server.
- A public scoreboard. See [SCOREBOARD.md](SCOREBOARD.md).
- More scenarios.
