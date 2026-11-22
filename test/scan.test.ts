import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  baseArguments,
  kindOf,
  optionalStrings,
  stringPoints,
  violations,
  withString,
} from "../src/scan/schema.ts";

async function run(
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runCli(argv, stdout.stream, stderr.stream);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
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

type Report = {
  server: string;
  tools: {
    name: string;
    status: string;
    reason?: string;
    calls: number;
    answered: boolean;
    findings: number;
  }[];
  findings: {
    kind: string;
    tier: string;
    cwe: string[];
    tool: string;
    argument?: string;
    detail: string;
    call: string;
    fix: string;
    more: number;
    accepted?: string[];
  }[];
  totals: { safety: number; robustness: number; note: number };
};

const ZOO = `"${process.execPath}" {cwd}/test/fixtures/mcp-zoo.mjs`;

async function scan(
  mode: string,
  ...rest: string[]
): Promise<{ code: number; report: Report; stderr: string }> {
  const result = await run([
    "scan",
    "--mcp",
    `${ZOO} ${mode}`,
    "--timeout",
    "1500",
    "--json",
    ...rest,
  ]);
  return {
    code: result.code,
    report: JSON.parse(result.stdout) as Report,
    stderr: result.stderr,
  };
}

function scanDirs(): string[] {
  return readdirSync(os.tmpdir()).filter((name) =>
    name.startsWith("gauntlet-scan-"),
  );
}

test("a scan finds each flaw the vulnerable server has, and where", async () => {
  const before = scanDirs();
  const { code, report } = await scan("vulnerable");
  expect(code).toBe(1);
  expect(report.server).toBe("zoo vulnerable");
  const found = report.findings.map((finding) =>
    [finding.tier, finding.kind, finding.tool, finding.argument ?? ""].join(
      " ",
    ),
  );
  expect(found.sort()).toEqual(
    [
      "safety phantom-tool constructor ",
      "safety outside-read read_note path",
      "safety outside-write save_note name",
      "safety outside-list list_notes dir",
      "safety shell-injection grep_notes pattern",
      "safety url-file-read fetch_page url",
      "note loopback-fetch fetch_page url",
      "robustness crash title_case text",
      "robustness hang wait_for text",
      "robustness schema-not-enforced add ",
      "robustness schema-not-enforced grep_notes ",
      "robustness schema-not-enforced save_note ",
    ].sort(),
  );
  expect(report.totals).toEqual({ safety: 6, robustness: 5, note: 1 });
  const by = (kind: string) =>
    report.findings.find((item) => item.kind === kind);
  // Every finding carries the call that did it and a line on the fix.
  for (const finding of report.findings) {
    expect(finding.call, finding.kind).toMatch(/^\{"name":/);
    expect(finding.fix.length, finding.kind).toBeGreaterThan(20);
  }
  expect(by("outside-read")).toMatchObject({ cwe: ["CWE-22"] });
  expect(by("outside-read")?.call).toMatch(
    /^\{"name":"read_note","arguments":\{"path":"\.\.\/gauntlet-outside-[0-9a-f]{8}\.txt"\}\}$/,
  );
  expect(by("outside-read")?.more).toBeGreaterThan(2);
  expect(by("shell-injection")).toMatchObject({ cwe: ["CWE-78"] });
  expect(by("shell-injection")?.call).toContain("; touch ");
  expect(by("url-file-read")?.call).toContain('"url":"file:///');
  expect(by("phantom-tool")?.detail).toBe(
    'The server answered a call to "constructor", "toString", "__proto__", "hasOwnProperty", which are not in its list of tools.',
  );
  // A value nobody would read is printed as a short stand-in.
  expect(by("crash")?.call).toBe(
    '{"name":"title_case","arguments":{"text":"[[[[... 10000 arrays deep"}}',
  );
  expect(by("hang")?.call).toBe(
    '{"name":"wait_for","arguments":{"text":"AAAA... 200000 characters"}}',
  );
  expect(by("schema-not-enforced")?.accepted).toContain(
    "name as a number, where the schema says string",
  );
  // The loopback note is from the address made for it, not from a payload
  // that happened to start with an address.
  expect(by("loopback-fetch")?.call).toMatch(
    /127\.0\.0\.1:\d+\/gauntlet-[0-9a-f]{8}"\}\}$/,
  );
  expect(scanDirs()).toEqual(before);
});

test("a tool that runs commands by design is not an injection", async () => {
  const { report } = await scan("vulnerable", "--tool", "run_shell");
  const shell = report.tools.find((tool) => tool.name === "run_shell");
  expect(shell).toMatchObject({
    status: "scanned",
    answered: true,
    findings: 0,
  });
  // The phantom tool names are a check on the server, not on run_shell.
  expect(report.findings.map((finding) => finding.kind)).toEqual([
    "phantom-tool",
  ]);
});

test("the same server written safely gives a scan nothing to report", async () => {
  const { code, report, stderr } = await scan("safe");
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(report.findings).toEqual([]);
  expect(report.totals).toEqual({ safety: 0, robustness: 0, note: 0 });
  const rows = new Map(report.tools.map((tool) => [tool.name, tool]));
  for (const name of [
    "read_note",
    "save_note",
    "list_notes",
    "grep_notes",
    "fetch_page",
    "add",
    "title_case",
    "wait_for",
    "run_shell",
  ]) {
    // A clean row counts because the plain call got a result.
    expect(rows.get(name), name).toMatchObject({
      status: "scanned",
      answered: true,
    });
    expect(rows.get(name)?.calls, name).toBeGreaterThan(3);
  }
  expect(rows.get("needs_key")).toMatchObject({
    status: "scanned",
    answered: false,
  });
  expect(rows.get("drop_all")).toMatchObject({
    status: "skipped",
    reason: "the server marks it destructive",
    calls: 0,
  });
});

test("the text report says what was not looked at", async () => {
  const result = await run([
    "scan",
    "--mcp",
    `${ZOO} safe`,
    "--timeout",
    "1500",
    "--name",
    "zoo",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(
    /^scan: zoo\nserver: zoo safe\n\ntool +status +calls +plain call +findings\n/,
  );
  expect(result.stdout).toMatch(/\nneeds_key +scanned +\d+ +refused +0\n/);
  expect(result.stdout).toMatch(
    /\ndrop_all +skipped +- +- +- +the server marks it destructive\n/,
  );
  expect(result.stdout).toContain(
    "0 safety, 0 robustness, 0 notes.\n9 of 10 scanned tools answered a plain call.\n1 tool was not called because the server marks it destructive. --destructive calls it too.\nNo finding means little for the other 1: a server that turns every call down gives nothing to find.\n",
  );
  const loud = await run([
    "scan",
    "--mcp",
    `${ZOO} vulnerable`,
    "--timeout",
    "1500",
    "--tool",
    "read_note,add,save_note",
  ]);
  expect(loud.code).toBe(1);
  expect(loud.stdout).toContain(
    "2. safety  outside-read  read_note.path  CWE-22\n",
  );
  expect(loud.stdout).toContain(
    "   fix:  Resolve the path against the allowed directory, follow symlinks, and refuse a result outside it.\n",
  );
  // Tools that do not check their schema share one entry.
  expect(loud.stdout).toMatch(
    /\d+\. robustness {2}schema-not-enforced {2}2 tools {2}CWE-20\n {3}The server gave a result for arguments its own schema rules out\.\n {3}save_note: .*\n {3}add: a as a string, where the schema says number; /,
  );
});

test("the server sees nothing of the environment it was not given", async () => {
  process.env.ZOO_KEY = "from-the-shell";
  process.env.ZOO_SECRET = "must-not-leak";
  try {
    const without = await scan("safe", "--tool", "needs_key");
    expect(
      without.report.tools.find((tool) => tool.name === "needs_key"),
    ).toMatchObject({
      answered: false,
    });
    const passed = await scan(
      "safe",
      "--tool",
      "needs_key",
      "--env",
      "ZOO_KEY",
    );
    expect(
      passed.report.tools.find((tool) => tool.name === "needs_key"),
    ).toMatchObject({
      answered: true,
    });
    const set = await scan("safe", "--tool", "needs_key", "--env", "ZOO_KEY=1");
    expect(
      set.report.tools.find((tool) => tool.name === "needs_key"),
    ).toMatchObject({
      answered: true,
    });
  } finally {
    delete process.env.ZOO_KEY;
    delete process.env.ZOO_SECRET;
  }
  const missing = await run([
    "scan",
    "--mcp",
    `${ZOO} safe`,
    "--env",
    "GAUNTLET_NOT_SET_ANYWHERE",
  ]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toBe(
    "--env GAUNTLET_NOT_SET_ANYWHERE is not set here\n",
  );
});

test("filters, --ignore, and --fail-on decide what is scanned and what fails", async () => {
  const only = await scan("vulnerable", "--tool", "read_note", "--skip", "add");
  expect(
    only.report.tools
      .filter((tool) => tool.status === "scanned")
      .map((tool) => tool.name),
  ).toEqual(["read_note"]);
  expect(only.report.tools.find((tool) => tool.name === "add")?.reason).toBe(
    "not named with --tool",
  );
  const skipped = await scan(
    "vulnerable",
    "--skip",
    "read_note,title_case,wait_for",
  );
  expect(
    skipped.report.tools.find((tool) => tool.name === "read_note"),
  ).toMatchObject({
    status: "skipped",
    reason: "named with --skip",
  });
  expect(
    skipped.report.findings.some((finding) => finding.tool === "read_note"),
  ).toBe(false);

  const args = ["--tool", "read_note,add"];
  expect((await scan("vulnerable", ...args)).code).toBe(1);
  expect((await scan("vulnerable", ...args, "--fail-on", "none")).code).toBe(0);
  const ignored = await scan(
    "vulnerable",
    ...args,
    "--ignore",
    "outside-read:read_note",
    "--ignore",
    "phantom-tool",
    "--fail-on",
    "safety",
  );
  expect(ignored.code).toBe(0);
  expect(ignored.stderr).toBe("note: 2 findings left out by --ignore\n");
  expect(ignored.report.findings.map((finding) => finding.kind)).toEqual([
    "schema-not-enforced",
  ]);
  expect(
    (
      await scan(
        "vulnerable",
        ...args,
        "--ignore",
        "outside-read",
        "--ignore",
        "phantom-tool",
        "--fail-on",
        "robustness",
      )
    ).code,
  ).toBe(1);
});

test("--destructive calls a tool the server marks destructive", async () => {
  const { report } = await scan("safe", "--tool", "drop_all", "--destructive");
  expect(report.tools.find((tool) => tool.name === "drop_all")).toMatchObject({
    status: "scanned",
    answered: true,
    calls: 1,
  });
});

test("a bad command line or a server that cannot start exits 2", async () => {
  const cases: [string[], string][] = [
    [["scan"], "missing --mcp\n"],
    [["scan", "--mcp"], "missing --mcp value\n"],
    [["scan", "--mcp", "true", "--nope"], "unknown argument --nope\n"],
    [["scan", "--mcp", "true", "--timeout", "0"], "invalid --timeout\n"],
    [
      ["scan", "--mcp", "true", "--fail-on", "maybe"],
      "invalid --fail-on maybe; one of any, safety, robustness, none\n",
    ],
    [["scan", "--mcp", "true", "--env", "1BAD=x"], "invalid --env 1BAD=x\n"],
    [
      ["scan", "--mcp", "exit 3"],
      "could not scan the MCP server: mcp server exited 3\n",
    ],
    [
      ["scan", "--mcp", `${ZOO} safe`, "--tool", "no_such_tool"],
      "the MCP server has no tool named no_such_tool. Its tools: read_note, save_note, list_notes, grep_notes, fetch_page, add, title_case, wait_for, run_shell, needs_key, drop_all\n",
    ],
  ];
  for (const [argv, message] of cases) {
    const result = await run(argv);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.stderr, argv.join(" ")).toBe(message);
    expect(result.stdout).toBe("");
  }
  const ignore = await run(["scan", "--mcp", "true", "--ignore", "everything"]);
  expect(ignore.code).toBe(2);
  expect(ignore.stderr).toMatch(
    /^unknown finding everything; one of outside-read, /,
  );
  const help = await run(["scan", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("gauntlet scan --mcp <cmd>");
});

test("no server is left running after a scan that crashed and hung it", async () => {
  await scan("vulnerable", "--tool", "title_case,wait_for");
  const alive = (): string[] =>
    spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(
        (line) =>
          /fixtures\/mcp-zoo\.mjs/.test(line) &&
          (line.startsWith(process.execPath) || /^(\/bin\/)?sh -c /.test(line)),
      );
  const deadline = Date.now() + 4000;
  while (alive().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(alive()).toEqual([]);
});

const values = {
  path: "notes.txt",
  dir: "sub",
  fresh: "new.txt",
  url: "http://127.0.0.1:1/ok",
};

test("an argument's kind comes from its name, its format, and its description", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["path", {}, "path"],
    ["filePath", {}, "path"],
    ["source_file", {}, "path"],
    ["outputDir", {}, "path"],
    ["cwd", {}, "path"],
    ["url", {}, "url"],
    ["webhookUrl", {}, "url"],
    ["link", { format: "uri" }, "url"],
    ["target", { format: "uri" }, "url"],
    ["command", {}, "command"],
    ["script", {}, "command"],
    ["query", {}, "text"],
    ["pattern", {}, "text"],
    ["name", { description: "Path to the file to read" }, "path"],
    ["where", { description: "The URL to fetch" }, "url"],
    ["profile", {}, "text"],
    ["title", {}, "text"],
  ];
  for (const [name, schema, kind] of cases) {
    expect(kindOf(name, schema), name).toBe(kind);
  }
});

test("a plain call has every required argument, with a value of its type", () => {
  const schema = {
    type: "object",
    required: [
      "path",
      "destination",
      "dir",
      "count",
      "mode",
      "tags",
      "options",
      "flag",
      "since",
      "url",
      "command",
      "note",
    ],
    properties: {
      path: { type: "string" },
      destination: { type: "string" },
      dir: { type: "string" },
      count: { type: "integer", minimum: 5, maximum: 9 },
      mode: { type: "string", enum: ["fast", "slow"] },
      tags: { type: "array", items: { type: "string" } },
      options: {
        type: "object",
        required: ["cwd"],
        properties: { cwd: { type: "string" }, extra: { type: "string" } },
      },
      flag: { type: "boolean" },
      since: { type: "string", format: "date-time" },
      url: { type: "string" },
      command: { type: "string" },
      note: { type: ["string", "null"], minLength: 12 },
      skipped: { type: "string" },
    },
  };
  expect(baseArguments(schema, values)).toEqual({
    path: "notes.txt",
    destination: "new.txt",
    dir: "sub",
    count: 5,
    mode: "fast",
    tags: ["gauntlet"],
    options: { cwd: "sub" },
    flag: false,
    since: "2026-01-01T00:00:00Z",
    url: "http://127.0.0.1:1/ok",
    command: "echo gauntlet-ok",
    note: "gauntletgggg",
  });
  expect(baseArguments({}, values)).toEqual({});
  expect(
    baseArguments(
      {
        required: ["x"],
        properties: { x: { anyOf: [{ type: "null" }, { type: "number" }] } },
      },
      values,
    ),
  ).toEqual({ x: 1 });
  // A name from a schema is a key, never the prototype.
  const proto = baseArguments(
    { required: ["__proto__"], properties: {} },
    values,
  );
  expect(Object.keys(proto)).toEqual(["__proto__"]);
  expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
});

test("every free string in the arguments is a place for a payload", () => {
  const schema = {
    properties: {
      path: { type: "string" },
      mode: { type: "string", enum: ["a"] },
      files: { type: "array", items: { type: "string" } },
      options: { type: "object", properties: { cwd: { type: "string" } } },
      count: { type: "number" },
    },
  };
  const args = {
    path: "notes.txt",
    mode: "a",
    files: ["x"],
    options: { cwd: "sub" },
    count: 1,
  };
  const points = stringPoints(args, schema);
  expect(points.map((point) => [point.label, point.kind])).toEqual([
    ["path", "path"],
    ["files[0]", "path"],
    ["options.cwd", "path"],
  ]);
  const [, files, cwd] = points;
  if (!files || !cwd) throw new Error("missing points");
  expect(withString(args, files.pointer, "P")).toMatchObject({
    files: ["P"],
    path: "notes.txt",
  });
  expect(withString(args, cwd.pointer, "P")).toMatchObject({
    options: { cwd: "P" },
  });
  expect(args.files).toEqual(["x"]);
  expect(
    optionalStrings(
      {
        required: ["a"],
        properties: {
          a: { type: "string" },
          cwd: { type: "string" },
          n: { type: "number" },
        },
      },
      values,
    ),
  ).toEqual([{ name: "cwd", value: "sub" }]);
});

test("a violation is a wrong type or a missing required argument", () => {
  const schema = {
    required: ["a", "name"],
    additionalProperties: false,
    properties: { a: { type: "number" }, name: { type: "string" } },
  };
  const found = violations(schema, { a: 1, name: "x" });
  expect(found).toEqual([
    {
      label: "a as a string, where the schema says number",
      arguments: { a: "seven", name: "x" },
    },
    { label: "no a, which the schema requires", arguments: { name: "x" } },
    {
      label: "name as a number, where the schema says string",
      arguments: { a: 1, name: 7 },
    },
    { label: "no name, which the schema requires", arguments: { a: 1 } },
  ]);
  expect(violations({}, {})).toEqual([]);
});
