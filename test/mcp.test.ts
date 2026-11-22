import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { mcpAdapter } from "../src/adapters/mcp.ts";
import { runCli } from "../src/cli.ts";
import { CLASSIFICATION } from "../src/scenarios/classify.ts";
import { scenarios } from "../src/scenarios/index.ts";
import { renameTopLevelKeys, splitCall } from "../src/structured.ts";

type Row = { id: string; status: string; reason: string };

async function run(
  argv: readonly string[],
): Promise<{ code: number; rows: Row[]; stdout: string; stderr: string }> {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runCli(argv, stdout.stream, stderr.stream);
  let rows: Row[] = [];
  try {
    rows = (JSON.parse(stdout.text()) as { scenarios: Row[] }).scenarios;
  } catch {
    // Not a JSON report.
  }
  return { code, rows, stdout: stdout.text(), stderr: stderr.text() };
}

function memoryStream(): { stream: Writable; text: () => string } {
  let body = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  return { stream, text: () => body };
}

const REFERENCE = `"${process.execPath}" {cwd}/test/fixtures/mcp-reference.mjs`;
const ODD = `"${process.execPath}" {cwd}/test/fixtures/mcp-odd.mjs`;

function mcp(
  command: string,
  ...rest: string[]
): Promise<Awaited<ReturnType<typeof run>>> {
  return run(["run", "--mcp", command, "--json", ...rest]);
}

const executeIds = scenarios
  .filter((item) => item.layer === "execute" && !item.aborted)
  .map((item) => item.id);

test("every scenario is classified, and nothing else is", () => {
  expect(Object.keys(CLASSIFICATION).sort()).toEqual(
    scenarios.map((item) => item.id).sort(),
  );
  for (const item of scenarios) {
    for (const id of item.cwe) expect(id, item.id).toMatch(/^CWE-\d+$/);
  }
});

test("an execute scenario sends well-formed calls, and they split", () => {
  const sandbox = { rootDir: "/r", workspaceDir: "/r/w", outsideFile: "/r/o" };
  for (const item of scenarios) {
    if (item.layer !== "execute") continue;
    for (const probe of item.probes) {
      const raw = probe(sandbox);
      const split = splitCall(raw);
      expect(split, `${item.id}: ${raw.slice(0, 60)}`).toBeDefined();
      expect(
        `{"name":${split?.nameJson},"arguments":${split?.argumentsJson}}`,
      ).toBe(raw);
    }
  }
  expect(
    splitCall('{"name":"read_file","arguments":{"path":"a"}'),
  ).toBeUndefined();
  expect(splitCall("<read_file></read_file>")).toBeUndefined();
  const proto = splitCall(
    '{"name":"w","arguments":{"__proto__":{"path":"x"}}}',
  );
  expect(Object.keys(proto?.call.arguments ?? {})).toEqual(["__proto__"]);
});

test("a hardened MCP server passes every scenario it can be given", async () => {
  const result = await mcp(`${REFERENCE} hardened {workspace}`);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.rows.map((row) => row.id)).toEqual(
    scenarios.map((item) => item.id),
  );
  for (const row of result.rows) {
    const expected = executeIds.includes(row.id) ? "pass" : "not-covered";
    expect(row.status, `${row.id}: ${row.reason}`).toBe(expected);
  }
  const reasons = new Map(result.rows.map((row) => [row.id, row.reason]));
  expect(reasons.get("truncated-json")).toBe(
    "the scenario is about reading model output, and this target receives parsed calls",
  );
  expect(reasons.get("stream-aborted")).toBe(
    "the client drops an aborted call before a server sees it",
  );
});

test("a naive MCP server fails the safety scenarios", async () => {
  const result = await mcp(`${REFERENCE} naive {workspace}`);
  expect(result.code).toBe(1);
  const status = new Map(result.rows.map((row) => [row.id, row.status]));
  for (const id of [
    "proto-key-arguments",
    "inherited-tool-name",
    "unicode-trimmed-path",
    "path-escape",
    "path-escape-write",
    "path-symlink-write",
    "path-hardlink-write",
    "prompt-injection-result",
  ]) {
    expect(status.get(id), id).toBe("fail");
  }
  expect(status.get("content-whitespace-kept")).toBe("pass");
  // Every failure is a safety one, so a run that gates on robustness passes.
  const lenient = await mcp(
    `${REFERENCE} naive {workspace}`,
    "--fail-on",
    "robustness",
  );
  expect(lenient.code).toBe(0);
});

test("a server with its own tool names passes once they are mapped", async () => {
  const renamed = `${REFERENCE} hardened {workspace} renamed`;
  const mapped = await mcp(
    renamed,
    "--tool",
    "read_file=read_text_file",
    "--tool",
    "write_file=write_text_file",
  );
  expect(mapped.code).toBe(0);
  for (const row of mapped.rows) {
    if (executeIds.includes(row.id)) {
      expect(row.status, `${row.id}: ${row.reason}`).toBe("pass");
    }
  }
});

test("--tool is checked before anything runs", async () => {
  const cases: [string[], string][] = [
    [
      ["--adapter", "reference-hardened", "--tool", "read_file=x"],
      "--tool needs --mcp\n",
    ],
    [
      ["--mcp", "true", "--tool", "delete_file=x"],
      "invalid --tool delete_file=x; use read_file=<name> or write_file=<name>\n",
    ],
    [
      ["--mcp", "true", "--tool", "read_file="],
      "invalid --tool read_file=; use read_file=<name> or write_file=<name>\n",
    ],
    [
      ["--mcp", "true", "--adapter", "reference-naive"],
      "--adapter, --exec, --http, and --mcp are mutually exclusive\n",
    ],
  ];
  for (const [argv, message] of cases) {
    const result = await run(["run", ...argv]);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.stderr).toBe(message);
  }
});

test("a server that prints a banner and asks the client things still works", async () => {
  const result = await mcp(`${ODD} banner`, "--scenario", "deep-nesting");
  expect(result.stderr).toBe("");
  expect(result.rows).toMatchObject([
    {
      status: "pass",
      reason: "returned for 2000 and 10000 levels of nesting",
    },
  ]);
});

test("a server that crashes or hangs on a call is an error", async () => {
  const crash = await mcp(`${ODD} crash`, "--scenario", "deep-nesting");
  expect(crash.code).toBe(1);
  expect(crash.rows).toMatchObject([
    {
      status: "error",
      reason:
        "mcp server exited 3: RangeError: Maximum call stack size exceeded",
    },
  ]);
  const started = Date.now();
  const hang = await mcp(
    `${ODD} hang`,
    "--scenario",
    "deep-nesting",
    "--timeout",
    "1500",
  );
  expect(Date.now() - started).toBeLessThan(8000);
  expect(hang.rows).toMatchObject([
    { status: "error", reason: "mcp tools/call timed out after 1500ms" },
  ]);
});

test("a server that cannot start ends the run before it begins", async () => {
  const cases: [string[], string][] = [
    [
      [`${ODD} no-start`, "--scenario", "path-escape"],
      "could not start the MCP server: mcp server exited 4: cannot open the allowed directory",
    ],
    [["exit 0"], "could not start the MCP server: mcp server exited 0"],
    [
      ["sleep 30", "--timeout", "300"],
      "could not start the MCP server: mcp initialize timed out after 300ms",
    ],
    [
      [`${ODD} many-pages`],
      "could not start the MCP server: mcp tools/list did not end after 20 pages",
    ],
  ];
  for (const [argv, message] of cases) {
    const [command = "", ...rest] = argv;
    const result = await mcp(command, ...rest);
    expect(result.code, command).toBe(2);
    expect(result.stdout, command).toBe("");
    expect(result.stderr, command).toBe(`${message}\n`);
  }
});

test("a server whose tools have other names says so once", async () => {
  const renamed = `${REFERENCE} hardened {workspace} renamed`;
  const none = await mcp(renamed, "--scenario", "path-escape");
  expect(none.code).toBe(2);
  expect(none.stdout).toBe("");
  expect(none.stderr).toBe(
    "the MCP server has no tool named read_file or write_file. Its tools: read_text_file, write_text_file. Name the one that reads a file with --tool read_file=<name> and the one that writes with --tool write_file=<name>\n",
  );
  const half = await mcp(
    renamed,
    "--tool",
    "read_file=read_text_file",
    "--scenario",
    "path-escape,path-escape-write",
  );
  expect(half.code).toBe(0);
  expect(half.stderr).toBe(
    "note: the MCP server has no tool named write_file. Its tools: read_text_file, write_text_file. Scenarios that need it are not covered\n",
  );
  expect(half.rows).toMatchObject([
    { id: "path-escape", status: "pass" },
    {
      id: "path-escape-write",
      status: "not-covered",
      reason: "the server has no tool named write_file",
    },
  ]);
});

// The reason this check exists: every scenario below expects a refusal, and
// a server that refuses everything would pass them all.
test("a server that turns every call down is not scored", async () => {
  const result = await mcp(`${ODD} refuse-all`, "--category", "path,unicode");
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "the MCP server did not write a file in its own directory with write_file: Invalid arguments: file_path is required. Gauntlet sends a path relative to the server's directory. Check --tool and --arg\n",
  );
});

test("--arg renames the path and content arguments and nothing else", async () => {
  const server = `${REFERENCE} hardened {workspace} renamed-args`;
  const tools = [
    "--tool",
    "read_file=read_text_file",
    "--tool",
    "write_file=write_text_file",
  ];
  const mapped = await mcp(
    server,
    ...tools,
    "--arg",
    "path=file_path",
    "--arg",
    "content=text",
  );
  expect(mapped.stderr).toBe("");
  expect(mapped.code).toBe(0);
  for (const row of mapped.rows) {
    if (executeIds.includes(row.id)) {
      expect(row.status, `${row.id}: ${row.reason}`).toBe("pass");
    }
  }
  // Without the map the server never sees a path, and the control call that
  // comes before the run finds that out.
  const plain = await mcp(server, ...tools, "--scenario", "path-escape");
  expect(plain.code).toBe(2);
  expect(plain.stderr).toBe(
    "the MCP server did not write a file in its own directory with write_text_file: missing argument. Gauntlet sends a path relative to the server's directory. Check --tool and --arg\n",
  );
  const cases: [string[], string][] = [
    [
      ["--mcp", "true", "--arg", "encoding=x"],
      "invalid --arg encoding=x; use path=<name> or content=<name>\n",
    ],
    [
      ["--adapter", "reference-naive", "--arg", "path=x"],
      "--arg needs --mcp\n",
    ],
  ];
  for (const [argv, message] of cases) {
    const result = await run(["run", ...argv]);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.stderr).toBe(message);
  }
});

test("renameTopLevelKeys touches the outermost keys only", () => {
  const names = new Map([
    ["path", "file_path"],
    ["content", "text"],
  ]);
  const cases: [string, string][] = [
    ['{"path":"a","content":"b"}', '{"file_path":"a","text":"b"}'],
    [
      '{ "path" : "path" , "x" : {"path":1} }',
      '{ "file_path" : "path" , "x" : {"path":1} }',
    ],
    [
      '{"\\u0070ath":"a","tags":["path",{"content":"c"}]}',
      '{"file_path":"a","tags":["path",{"content":"c"}]}',
    ],
    ['{"__proto__":{"path":"x"}}', '{"__proto__":{"path":"x"}}'],
    [
      '{"content":"say \\"path\\":","path":"p"}',
      '{"text":"say \\"path\\":","file_path":"p"}',
    ],
    ["{}", "{}"],
  ];
  for (const [given, expected] of cases) {
    expect(renameTopLevelKeys(given, names), given).toBe(expected);
  }
  expect(renameTopLevelKeys('{"path":"a"}', new Map())).toBe('{"path":"a"}');
});

test("an error reply is a refusal, with or without the id of the request", async () => {
  for (const [mode, reason] of [
    ["rpc-error", "Invalid arguments\nsecond line"],
    ["null-id", "Parse error"],
  ] as const) {
    const result = await run([
      "run",
      "--mcp",
      `${ODD} ${mode}`,
      "--scenario",
      "path-escape",
      "--timeout",
      "3000",
      "--json",
      "--verbose",
    ]);
    const report = JSON.parse(result.stdout) as {
      scenarios: {
        status: string;
        tier: string;
        probes: { outcome: unknown }[];
      }[];
    };
    expect(report.scenarios[0]?.status, mode).toBe("pass");
    expect(report.scenarios[0]?.tier).toBe("safety");
    expect(report.scenarios[0]?.probes[0]?.outcome, mode).toEqual({
      status: "refused",
      reason,
    });
  }
});

test("a read that comes back inside an error has still leaked the file", async () => {
  const result = await mcp(
    `${ODD} leak`,
    "--scenario",
    "path-escape,path-symlink",
  );
  expect(result.code).toBe(1);
  expect(result.rows).toMatchObject([
    {
      id: "path-escape",
      status: "fail",
      reason: "dotdot read a file outside the workspace",
    },
    {
      id: "path-symlink",
      status: "fail",
      reason: "symlink read a file outside the workspace",
    },
  ]);
});

test("file text is found however the server wraps it", async () => {
  for (const mode of ["resource", "structured", "header"]) {
    const result = await mcp(
      `${ODD} ${mode}`,
      "--scenario",
      "prompt-injection-result,deep-nesting",
    );
    expect(result.rows, mode).toMatchObject([
      { id: "prompt-injection-result", status: "pass" },
      { id: "deep-nesting", status: "pass" },
    ]);
  }
});

test("tools are read across pages, and a missing one is not covered", async () => {
  const result = await mcp(
    `${ODD} paged`,
    "--scenario",
    "path-escape-write,deep-nesting",
  );
  expect(result.rows).toMatchObject([
    {
      id: "path-escape-write",
      status: "not-covered",
      reason: "the server has no tool named write_file",
    },
    { id: "deep-nesting", status: "pass" },
  ]);
});

// A server, or the sh that started one. A search of every command line
// would also find a shell or an editor showing this file's text.
function serversAlive(): string[] {
  return spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(
      (line) =>
        /fixtures\/mcp-(odd|reference)\.mjs/.test(line) &&
        (line.startsWith(process.execPath) || /^(\/bin\/)?sh -c /.test(line)),
    );
}

async function noServerLeft(): Promise<string[]> {
  const deadline = Date.now() + 4000;
  while (serversAlive().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return serversAlive();
}

test("no server is left running after a run", async () => {
  // stubborn stays alive when its input closes and ignores SIGTERM, so it is
  // only gone if its process group was killed.
  const stubborn = await mcp(
    `${ODD} stubborn`,
    "--scenario",
    "deep-nesting,path-unusable",
  );
  expect(stubborn.rows).toMatchObject([{ status: "pass" }, { status: "pass" }]);
  await mcp(`${ODD} hang`, "--scenario", "deep-nesting", "--timeout", "1500");
  await mcp(`${REFERENCE} hardened {workspace}`, "--category", "unicode");
  expect(await noServerLeft()).toEqual([]);
});

function readCall(dir: string) {
  const raw = '{"name":"read_file","arguments":{"path":"notes.txt"}}';
  const call = splitCall(raw)?.call;
  if (!call) throw new Error("no call");
  return { raw, sandboxDir: dir, aborted: false, call };
}

function outcome(running: Promise<unknown>): Promise<string> {
  return running.then(
    () => "returned",
    (error: Error) => error.message,
  );
}

test("a close while the server for a scenario is starting leaves none behind", async () => {
  const slow = `sleep 0.6; exec ${ODD.replaceAll("{cwd}", process.cwd())} stubborn`;
  const adapter = mcpAdapter(slow, 10_000, "slow", new Map());
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-test-"));
  try {
    // The control call first, so the close below lands on the start of the
    // scenario's own server and not on the control call.
    expect((await adapter.check()).problem).toBeUndefined();
    const failed = outcome(adapter.run(readCall(dir)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await adapter.close?.();
    await adapter.close?.();
    expect(await failed).toBe("mcp adapter was closed during a call");
    expect(await noServerLeft()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a close during the control call, or during a tools/call, leaves none behind", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-test-"));
  try {
    const slow = `sleep 0.6; exec ${ODD.replaceAll("{cwd}", process.cwd())} stubborn`;
    const early = mcpAdapter(slow, 10_000, "early", new Map());
    const closedEarly = outcome(early.run(readCall(dir)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await early.close?.();
    expect(await closedEarly).toBe("mcp adapter was closed during a call");

    const hung = mcpAdapter(
      `${ODD.replaceAll("{cwd}", process.cwd())} hang`,
      10_000,
      "hung",
      new Map(),
    );
    expect((await hung.check()).problem).toBeUndefined();
    const waiting = outcome(hung.run(readCall(dir)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await hung.close?.();
    expect(await waiting).toBe("mcp server stopped");
    expect(await noServerLeft()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one message over the limit is an error, and a long refusal is read to its end", async () => {
  const huge = await mcp(`${ODD} huge`, "--scenario", "deep-nesting");
  expect(huge.rows).toMatchObject([
    {
      status: "error",
      reason: "mcp server sent a message over 4194304 bytes",
    },
  ]);
  // The file comes back after 100000 characters of an error message.
  const late = await run([
    "run",
    "--mcp",
    `${ODD} leak-late`,
    "--scenario",
    "path-escape",
    "--json",
    "--verbose",
  ]);
  const report = JSON.parse(late.stdout) as {
    scenarios: {
      status: string;
      reason: string;
      probes: { outcome: { reason: string } }[];
    }[];
  };
  expect(report.scenarios[0]).toMatchObject({
    status: "fail",
    reason: "dotdot read a file outside the workspace",
  });
  // The check read all of it. The report prints the start.
  expect(report.scenarios[0]?.probes[0]?.outcome.reason).toHaveLength(4096);
});

test("a path with shell and replacement characters reaches the server whole", async () => {
  const odd = mkdtempSync(path.join(os.tmpdir(), "gauntlet $& $' $$ it's "));
  const before = process.cwd();
  const fixture = path.join(before, "test", "fixtures", "mcp-odd.mjs");
  try {
    writeFileSync(path.join(odd, "server.mjs"), readFileSync(fixture));
    process.chdir(odd);
    const result = await mcp(
      `"${process.execPath}" {cwd}/server.mjs banner`,
      "--scenario",
      "deep-nesting",
    );
    expect(result.stderr).toBe("");
    expect(result.rows).toMatchObject([{ status: "pass" }]);
  } finally {
    process.chdir(before);
    rmSync(odd, { recursive: true, force: true });
  }
});

test("--structured gives a black-box adapter the call as it was written", async () => {
  const command = `"${process.execPath}" test/fixtures/exec-structured.mjs`;
  const structured = await run([
    "run",
    "--exec",
    command,
    "--structured",
    "--json",
  ]);
  expect(structured.stderr).toBe("");
  expect(structured.code).toBe(0);
  for (const row of structured.rows) {
    const item = scenarios.find((scenario) => scenario.id === row.id);
    const expected = item?.layer === "execute" ? "pass" : "not-covered";
    expect(row.status, `${row.id}: ${row.reason}`).toBe(expected);
  }
  const raw = await run([
    "run",
    "--exec",
    command,
    "--scenario",
    "path-escape",
    "--json",
  ]);
  expect(raw.rows).toMatchObject([
    { status: "not-covered", reason: "no call in the probe" },
  ]);
});
