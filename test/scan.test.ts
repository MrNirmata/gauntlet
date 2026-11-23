import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  kindOf,
  nature,
  readSchema,
  soundsDestructive,
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

type Row = {
  name: string;
  status: string;
  reason?: string;
  calls: number;
  plain: string;
  anchored: boolean;
  strings: number;
  paths: number;
  unreached: number;
  findings: number;
};

type Report = {
  server: string;
  tools: Row[];
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
  stopped?: string;
  leftover?: string;
};

const NODE = `"${process.execPath}"`;
const ZOO = `${NODE} {cwd}/test/fixtures/mcp-zoo.mjs`;
const LAB = `${NODE} {cwd}/test/fixtures/mcp-lab.mjs`;

async function scanWith(
  command: string,
  ...rest: string[]
): Promise<{ code: number; report: Report; stderr: string }> {
  const result = await run([
    "scan",
    "--mcp",
    command,
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

// Most tests are about what a scan does to a tool once it is called, so
// these call every tool that is not held as destructive. plain() is what a
// scan does when it is told nothing.
const scan = (mode: string, ...rest: string[]) =>
  scanWith(`${ZOO} ${mode}`, "--write", ...rest);
const lab = (mode: string, ...rest: string[]) =>
  scanWith(`${LAB} ${mode}`, "--write", ...rest);
const plain = (command: string, ...rest: string[]) =>
  scanWith(command, ...rest);

function kinds(report: Report): string[] {
  return report.findings
    .map((finding) =>
      [finding.tier, finding.kind, finding.tool, finding.argument ?? ""]
        .join(" ")
        .trim(),
    )
    .sort();
}

function row(report: Report, name: string): Row {
  const found = report.tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

function scanDirs(): string[] {
  const dirs = new Set([os.tmpdir(), realpathSync(os.tmpdir())]);
  return [...dirs].flatMap((dir) =>
    readdirSync(dir).filter((name) => name.startsWith("gauntlet-scan-")),
  );
}

async function withDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(
    path.join(realpathSync(os.tmpdir()), "gauntlet-test-"),
  );
  try {
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a scan finds each flaw the vulnerable server has, and where", async () => {
  const before = scanDirs();
  const { code, report } = await scan("vulnerable");
  expect(code).toBe(1);
  expect(report.server).toBe("zoo vulnerable");
  expect(kinds(report)).toEqual(
    [
      "safety phantom-tool constructor",
      "safety outside-read read_note path",
      "safety outside-write save_note name",
      "safety outside-list list_notes dir",
      "safety shell-injection grep_notes pattern",
      "safety url-file-read fetch_page url",
      "note loopback-fetch fetch_page url",
      "robustness crash title_case text",
      "robustness hang wait_for text",
      "robustness schema-not-enforced add",
      "robustness schema-not-enforced grep_notes",
      "robustness schema-not-enforced save_note",
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
    /^\{"name":"read_note","arguments":\{"path":"\.\.\/gauntlet-[0-9a-f]{8}-outside\.txt"\}\}$/,
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
  // Tools seen to work in the scan's directory got the paths that leave it.
  for (const name of ["read_note", "save_note", "list_notes"]) {
    expect(row(report, name), name).toMatchObject({
      plain: "answered",
      anchored: true,
    });
  }
  expect(row(report, "add")).toMatchObject({ anchored: false, strings: 0 });
  expect(scanDirs()).toEqual(before);
});

test("the same server written safely gives a scan nothing to report", async () => {
  const { code, report, stderr } = await scan("safe");
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(report.findings).toEqual([]);
  expect(report.totals).toEqual({ safety: 0, robustness: 0, note: 0 });
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
    expect(row(report, name), name).toMatchObject({
      status: "scanned",
      plain: "answered",
    });
    expect(row(report, name).calls, name).toBeGreaterThan(2);
  }
  expect(row(report, "needs_key")).toMatchObject({
    status: "scanned",
    plain: "refused",
  });
  expect(row(report, "drop_all")).toMatchObject({
    status: "skipped",
    reason: "the server marks it destructive",
    calls: 0,
  });
  // drop_all leaves a file behind when it is called. The safe server's
  // list_notes would have listed it, and nothing did.
  expect(JSON.stringify(report)).not.toContain("drop-all-was-called");
});

test("the text report says what was not looked at", async () => {
  const result = await run([
    "scan",
    "--mcp",
    `${ZOO} safe`,
    "--timeout",
    "1500",
    "--write",
    "--name",
    "zoo",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(
    /^scan: zoo\nserver: zoo safe\n\ntool +status +calls +plain call +strings +paths +findings\n/,
  );
  expect(result.stdout).toMatch(
    /\nneeds_key +scanned +\d+ +refused +1 +0 +0\n/,
  );
  expect(result.stdout).toMatch(
    /\ndrop_all +skipped +- +- +- +- +- +the server marks it destructive\n/,
  );
  expect(result.stdout).toContain(
    "0 safety, 0 robustness, 0 notes.\n9 of 10 scanned tools answered a plain call.\nNo finding means little for the other 1: a tool that turns every call down gives nothing to find.\n1 tool was not called because it is marked or named as removing, sending, or spending. --destructive calls it too.\n",
  );
  const loud = await run([
    "scan",
    "--mcp",
    `${ZOO} vulnerable`,
    "--timeout",
    "1500",
    "--write",
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
  try {
    const without = await scan(
      "safe",
      "--tool",
      "needs_key",
      "--fail-on",
      "none",
    );
    expect(row(without.report, "needs_key")).toMatchObject({
      plain: "refused",
    });
    const passed = await scan(
      "safe",
      "--tool",
      "needs_key",
      "--env",
      "ZOO_KEY",
    );
    expect(row(passed.report, "needs_key")).toMatchObject({
      plain: "answered",
    });
    const set = await scan(
      "safe",
      "--tool",
      "needs_key",
      "--env",
      "ZOO_KEY=a=b",
    );
    expect(row(set.report, "needs_key")).toMatchObject({ plain: "answered" });
  } finally {
    delete process.env.ZOO_KEY;
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
  expect(row(only.report, "add").reason).toBe("not named with --tool");
  const skipped = await scan(
    "vulnerable",
    "--skip",
    "read_note,title_case,wait_for",
  );
  expect(row(skipped.report, "read_note")).toMatchObject({
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
  // The row counts what the report shows.
  expect(row(ignored.report, "read_note").findings).toBe(0);
  expect(row(ignored.report, "add").findings).toBe(1);
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

test("a bad command line or a server that cannot start exits 2", async () => {
  const before = scanDirs();
  const tools =
    "read_note, save_note, list_notes, grep_notes, fetch_page, add, title_case, wait_for, run_shell, needs_key, drop_all";
  const cases: [string[], string][] = [
    [["scan"], "missing --mcp\n"],
    [["scan", "--mcp"], "missing --mcp value\n"],
    [["scan", "--mcp", "true", "--nope"], "unknown argument --nope\n"],
    // A list with nothing in it is not "every tool".
    [["scan", "--mcp", "true", "--tool", ","], "missing --tool value\n"],
    [["scan", "--mcp", "true", "--skip", " , "], "missing --skip value\n"],
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
      `the MCP server has no tool named no_such_tool. Its tools: ${tools}\n`,
    ],
    [
      ["scan", "--mcp", `${ZOO} safe`, "--tool", "add", "--ignore", "crash:ad"],
      `--ignore names ad, which is not a tool of this server. Its tools: ${tools}\n`,
    ],
  ];
  for (const [argv, message] of cases) {
    const result = await run(argv);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.stderr, argv.join(" ")).toBe(message);
  }
  const ignore = await run(["scan", "--mcp", "true", "--ignore", "everything"]);
  expect(ignore.code).toBe(2);
  expect(ignore.stderr).toMatch(
    /^unknown finding everything; one of outside-read, /,
  );
  const help = await run(["scan", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("gauntlet scan --mcp <cmd>");
  // A server that did not start leaves no directory and no listener behind.
  expect(scanDirs()).toEqual(before);
});

test("a tool named for removing or sending is not called unless asked for", async () => {
  await withDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    const called = (): string[] =>
      existsSync(log)
        ? [...new Set(readFileSync(log, "utf8").trim().split("\n"))].sort()
        : [];
    const plain = await lab(`log ${log}`);
    expect(plain.code).toBe(0);
    expect(called()).toEqual(["list_things"]);
    for (const name of ["delete_everything", "send_email", "removeAccount"]) {
      expect(row(plain.report, name), name).toMatchObject({
        status: "skipped",
        reason: "its name says it removes, sends, or spends",
      });
    }
    rmSync(log, { force: true });

    // A misspelled --skip is found before anything is called. It must not
    // go on to call the tool it was meant to leave alone.
    const typo = await run([
      "scan",
      "--mcp",
      `${LAB} log ${log}`,
      "--destructive",
      "--skip",
      "delete_everthing",
    ]);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toBe(
      "the MCP server has no tool named delete_everthing. Its tools: delete_everything, send_email, list_things, removeAccount\n",
    );
    expect(called()).toEqual([]);

    // So is a misspelled --ignore.
    const stray = await run([
      "scan",
      "--mcp",
      `${LAB} log ${log}`,
      "--ignore",
      "crash:list_thing",
    ]);
    expect(stray.code).toBe(2);
    expect(stray.stderr).toMatch(
      /^--ignore names list_thing, which is not a tool/,
    );
    expect(called()).toEqual([]);

    // --plan lists what would be called and calls nothing.
    const plan = await run(["scan", "--mcp", `${LAB} log ${log}`, "--plan"]);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toMatch(/\nlist_things +planned +- +- +0 +- +-\n/);
    expect(plan.stdout).toMatch(
      /\nsend_email +skipped +- +- +- +- +- +its name says it removes, sends, or spends\n/,
    );
    expect(plan.stdout).toContain(
      "1 of 4 tools would be called. No tool was called.\n",
    );
    expect(called()).toEqual([]);

    // Named with --tool: the user asked for this one.
    await lab(`log ${log}`, "--tool", "send_email");
    expect(called()).toEqual(["send_email"]);
    rmSync(log, { force: true });
    await lab(`log ${log}`, "--destructive");
    expect(called()).toEqual([
      "delete_everything",
      "list_things",
      "removeAccount",
      "send_email",
    ]);
  });
});

test("a server that keeps its data elsewhere is not sent paths that leave a directory", async () => {
  await withDir(async (dir) => {
    const data = path.join(dir, "data");
    mkdirSync(data);
    writeFileSync(path.join(data, "notes.txt"), "the user's real notes\n");
    writeFileSync(path.join(dir, "beside.txt"), "beside the data\n");
    const { report } = await lab(`datadir ${data}`);
    expect(row(report, "save_note")).toMatchObject({
      plain: "answered",
      anchored: false,
    });
    // Nothing that was there was touched, and nothing landed beside it.
    expect(readFileSync(path.join(data, "notes.txt"), "utf8")).toBe(
      "the user's real notes\n",
    );
    expect(readdirSync(dir).sort()).toEqual(["beside.txt", "data"]);
    expect(readFileSync(path.join(dir, "beside.txt"), "utf8")).toBe(
      "beside the data\n",
    );
    // What the scan did leave there is named so that it names nothing else.
    for (const name of readdirSync(data)) {
      if (name === "notes.txt") continue;
      expect(name, name).toMatch(/^(gauntlet-[0-9a-f]{8}|987654321)/);
    }
    // The scan cannot see into the data directory, and does not claim to.
    expect(
      report.findings.some(
        (finding) =>
          finding.kind === "outside-write" && finding.tool === "save_note",
      ),
    ).toBe(false);
  });
});

test("a tool that takes a short path there and a full path anywhere gets full paths only", async () => {
  await withDir(async (dir) => {
    const data = path.join(dir, "data");
    mkdirSync(data);
    const { report } = await lab(`datadir ${data}`, "--tool", "put_file");
    // Seen to work with a path in full, and found to write outside with one.
    expect(row(report, "put_file")).toMatchObject({
      plain: "answered",
      anchored: true,
    });
    const outside = report.findings.find(
      (finding) => finding.kind === "outside-write",
    );
    expect(outside?.detail).toContain("written in full");
    for (const finding of report.findings) {
      if (finding.argument === "path" && finding.kind === "outside-write") {
        expect(finding.call).toMatch(/"path":"\//);
      }
    }
    // No ../ was resolved against the data directory.
    expect(readdirSync(dir)).toEqual(["data"]);
  });
});

test("a tool is tried with each form of path until it is seen to work", async () => {
  const { report } = await lab("forms");
  expect(kinds(report).filter((kind) => kind.startsWith("safety"))).toEqual(
    [
      "safety outside-list list_dir path",
      "safety outside-read read_blob path",
      "safety outside-write make_dir path",
      "safety outside-write edit_text path",
    ].sort(),
  );
  // A directory, a name that is not there yet, a file whose text changes,
  // and a file that comes back as base64.
  for (const name of ["list_dir", "make_dir", "edit_text", "read_blob"]) {
    expect(row(report, name), name).toMatchObject({
      plain: "answered",
      anchored: true,
    });
  }
  // Nothing shows this one reading the scan's directory, and the row says so.
  expect(row(report, "stat_file")).toMatchObject({
    plain: "answered",
    anchored: false,
    reason:
      "no path that leaves a directory was sent to path: not seen to name a file in the scan's directory",
  });
});

test("a server that reports a failure as a result is not judged on results", async () => {
  const { code, report } = await lab("errtext");
  expect(code).toBe(0);
  expect(
    report.findings.map((finding) => [finding.tier, finding.kind]),
  ).toEqual([["note", "soft-errors"]]);
  expect(report.findings[0]?.fix).toContain("isError");
});

test("a schema that allows two types, or a strict boolean, is not a finding", async () => {
  const { code, report } = await lab("anyof");
  expect(code).toBe(0);
  expect(report.findings).toEqual([]);
  expect(row(report, "set_value").plain).toBe("answered");
  expect(row(report, "toggle").plain).toBe("answered");
  // A $ref to a schema that allows two types allows two types.
  expect(row(report, "set_pair").plain).toBe("answered");
});

test("shell payloads go to every string, and a tool that runs commands is not an injection", async () => {
  const { report } = await lab("shell");
  // zip_code has "code" in its name. It is still put into a command. So is
  // the file of a tool whose description only mentions a command of its own.
  expect(kinds(report)).toEqual([
    "robustness schema-not-enforced file_history",
    "robustness schema-not-enforced geo_lookup",
    "safety shell-injection file_history file",
    "safety shell-injection geo_lookup zip_code",
  ]);
  // What was held back is said, not left out quietly.
  expect(row(report, "bash")).toMatchObject({
    plain: "answered",
    findings: 0,
    reason:
      "no command was put in its arguments: the tool runs commands by design",
  });
  expect(row(report, "launch")).toMatchObject({
    plain: "answered",
    findings: 0,
    reason: "no command was added to command: it takes a command",
  });
  const zoo = await scan("vulnerable", "--tool", "run_shell");
  expect(row(zoo.report, "run_shell")).toMatchObject({
    plain: "answered",
    findings: 0,
  });
});

test("a tool that only takes paths in full is given the escapes in full", async () => {
  const { code, report } = await lab("absolute");
  expect(code).toBe(1);
  expect(kinds(report)).toEqual(["safety outside-read read_file path"]);
  expect(report.findings[0]?.detail).toContain("written in full");
  expect(row(report, "read_file")).toMatchObject({
    plain: "answered",
    anchored: true,
  });
});

test("a tool that removes what it is given does not end the scan", async () => {
  const before = scanDirs();
  // Its name says what it does, so it is called only when asked for.
  expect(row((await lab("clear", "--plan")).report, "clear_path").status).toBe(
    "skipped",
  );
  const { code, report } = await lab("clear", "--tool", "clear_path");
  expect(code).toBe(1);
  expect(kinds(report)).toContain("safety outside-write clear_path path");
  expect(row(report, "clear_path").calls).toBeGreaterThan(10);
  expect(report.stopped).toBeUndefined();
  expect(scanDirs()).toEqual(before);
});

test("a command that runs later is filed under the argument that carried it", async () => {
  const { report } = await lab("background");
  const injection = report.findings.filter(
    (finding) => finding.kind === "shell-injection",
  );
  expect(injection.map((finding) => [finding.tool, finding.argument])).toEqual([
    ["queue_search", "query"],
  ]);
  expect(row(report, "ping").findings).toBe(0);
});

// A pretend home: data the server keeps, data beside it, and a file above.
function userHome(dir: string): { notes: string; listing: () => string[] } {
  const notes = path.join(dir, "data", "notes");
  mkdirSync(notes, { recursive: true });
  mkdirSync(path.join(dir, "data", "exports"));
  writeFileSync(path.join(notes, "todo.txt"), "todo\n");
  writeFileSync(path.join(dir, "data", "other.txt"), "other\n");
  writeFileSync(path.join(dir, "precious.txt"), "precious\n");
  return {
    notes,
    // Everything but what the scan's plain calls left in the notes.
    listing: () =>
      [
        ...readdirSync(dir).map((name) => name),
        ...readdirSync(path.join(dir, "data")).map((name) => `data/${name}`),
        ...readdirSync(notes)
          .filter((name) => !/^(gauntlet-[0-9a-f]{8}|987654321)/.test(name))
          .map((name) => `data/notes/${name}`),
      ].sort(),
  };
}

const INTACT = [
  "data",
  "data/exports",
  "data/notes",
  "data/notes.calls",
  "data/notes/todo.txt",
  "data/other.txt",
  "precious.txt",
];

function sentTo(log: string, tool: string): Record<string, unknown>[] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.startsWith(`${tool} `))
    .map((line) => JSON.parse(line.slice(tool.length + 1)));
}

// What would name the data directory itself or a place above it.
const leaves = (value: unknown): boolean =>
  value === "" || value === ".." || String(value).startsWith("../");

test("a file the server writes for itself does not make a scan trust it", async () => {
  await withDir(async (dir) => {
    const home = userHome(dir);
    // The server appends to server.log in the scan's directory on every
    // call. That is not the tool using its argument there.
    const { report } = await lab(`cwdlog ${home.notes}`);
    for (const name of ["read_note", "save_note", "tidy"]) {
      expect(row(report, name), name).toMatchObject({
        anchored: false,
        paths: 0,
      });
    }
    expect(home.listing()).toEqual(INTACT);
    expect(readFileSync(path.join(home.notes, "todo.txt"), "utf8")).toBe(
      "todo\n",
    );
    const calls = `${home.notes}.calls`;
    for (const tool of ["save_note", "tidy"]) {
      const sent = sentTo(calls, tool);
      expect(sent.length, tool).toBeGreaterThan(5);
      for (const args of sent) {
        // Always there, and never empty, even when the value was 10000
        // nested arrays and the server took the string out of the middle.
        expect(Object.hasOwn(args, "name"), JSON.stringify(args)).toBe(true);
        expect(leaves(args.name), JSON.stringify(args)).toBe(false);
      }
    }
    expect(
      report.findings.filter((finding) => finding.tier === "safety"),
    ).toEqual([]);
  });
});

test("an argument seen to work in the scan's directory does not vouch for the one beside it", async () => {
  await withDir(async (dir) => {
    const home = userHome(dir);
    const { report } = await lab(`mixed ${home.notes}`);
    // source is read where the server runs, and is tried with ../. name goes
    // to the data directory, and is not.
    expect(row(report, "import_note")).toMatchObject({
      plain: "answered",
      anchored: true,
      strings: 2,
      paths: 1,
    });
    expect(kinds(report)).toContain("safety outside-read import_note source");
    for (const args of sentTo(`${home.notes}.calls`, "import_note")) {
      expect(leaves(args.name), JSON.stringify(args)).toBe(false);
    }
    expect(home.listing()).toEqual(INTACT);
  });
});

test("a plain call picks the option and the switches that do least, and no later call undoes them", async () => {
  await withDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    // --destructive, because sync_things requires "force" and is held.
    const held = await lab(`choices ${log}`);
    expect(row(held.report, "sync_things")).toMatchObject({
      status: "skipped",
      reason: "it requires a confirmation",
    });
    rmSync(log, { force: true });
    await lab(`choices ${log}`, "--destructive");
    const actions = sentTo(log, "manage_notes").map((args) => args.action);
    expect(actions).toContain("list");
    expect(actions).not.toContain("delete_all");
    expect(actions).not.toContain("archive");
    const synced = sentTo(log, "sync_things");
    expect(synced.length).toBeGreaterThan(0);
    // Every call, the ones meant to break the schema included.
    for (const args of synced) {
      expect(args).toEqual({
        skip_safety_check: false,
        no_dry_run: false,
        disable_preview: false,
        dry_run: true,
        force: false,
        keep: true,
      });
    }
    // An optional switch or option is not added to a call. Nothing can be
    // put in one, and adding it only makes the call do more.
    const loaded = sentTo(log, "load_notes");
    expect(loaded.length).toBeGreaterThan(5);
    for (const args of loaded) {
      expect(Object.keys(args)).toEqual(["source"]);
    }
    // An argument is never left out of a tool that is not marked read-only.
    for (const args of sentTo(log, "count_rows")) {
      expect(Object.keys(args).sort()).toEqual(["limit", "table"]);
    }
  });
});

test("marks and names decide which tools are left alone", async () => {
  const named = "its name says it removes, sends, or spends";
  const unknown = "nothing says it only reads";
  const reasons = (report: Report): Record<string, string | undefined> =>
    Object.fromEntries(report.tools.map((tool) => [tool.name, tool.reason]));
  // Told nothing, a scan calls what is marked or named as only reading.
  const told = await plain(`${LAB} marks`, "--plan", "--json");
  const expected: Record<string, string | undefined> = {
    clear_all: named,
    cleanup: named,
    prune_old: named,
    deletefile: named,
    XMLDelete: named,
    DBDrop: named,
    stop_server: named,
    expire_sessions: named,
    sync_state:
      "the server says it is not read-only, and the default for that is destructive",
    apply_plan: "the server marks it destructive",
    // What the server says outright counts for more than the name.
    delete_cache:
      "the server marks it as not destructive, and not as read-only",
    get_post: undefined,
    list_orders: undefined,
    read_email: undefined,
    toString: unknown,
    seed_store: "it requires a confirmation",
    list_and_purge: named,
  };
  expect(reasons(told.report)).toEqual(expected);
  // --write adds the ones that change things without removing any.
  const write = await lab("marks", "--plan");
  expect(reasons(write.report)).toEqual({
    ...expected,
    delete_cache: undefined,
    toString: undefined,
  });
  const all = await lab("marks", "--plan", "--destructive");
  expect(all.report.tools.every((tool) => tool.status === "planned")).toBe(
    true,
  );
  // The server really has a tool called toString. Answering it is not
  // answering a name it does not list.
  const real = await lab("marks", "--tool", "toString,get_post");
  expect(real.code).toBe(0);
  expect(real.report.findings).toEqual([]);
});

test("told nothing, a scan calls only tools that are marked or named as reading", async () => {
  const { code, report } = await plain(
    `${ZOO} vulnerable`,
    "--timeout",
    "1500",
  );
  expect(code).toBe(1);
  for (const name of [
    "save_note",
    "add",
    "title_case",
    "wait_for",
    "run_shell",
    "needs_key",
  ]) {
    expect(row(report, name), name).toMatchObject({
      status: "skipped",
      reason: "nothing says it only reads",
      calls: 0,
    });
  }
  // What it does call, it tests as before.
  expect(kinds(report)).toEqual(
    [
      "safety phantom-tool constructor",
      "safety outside-read read_note path",
      "safety outside-list list_notes dir",
      "safety shell-injection grep_notes pattern",
      "safety url-file-read fetch_page url",
      "note loopback-fetch fetch_page url",
      "robustness schema-not-enforced grep_notes",
    ].sort(),
  );
  const text = await run(["scan", "--mcp", `${ZOO} safe`, "--timeout", "1500"]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(
    "4 of 4 scanned tools answered a plain call.\n6 tools were not called because nothing marks or names them as only reading. --write calls them too, with made-up arguments.\n1 tool was not called because it is marked or named as removing, sending, or spending. --destructive calls it too.\n",
  );
  // A server with nothing that reads is not a clean scan.
  const none = await run(["scan", "--mcp", `${LAB} softtool`]);
  expect(none.code).toBe(2);
  expect(none.stderr).toBe(
    "no tool was called, so nothing was tested. Nothing marks or names any of them as only reading. --write calls them, with made-up arguments\n",
  );
});

test("a directory of the scan's that a call turned into a link is not cleaned through", async () => {
  await withDir(async (dir) => {
    const home = userHome(dir);
    const before = scanDirs();
    // link_store puts a symlink to the user's notes where it is told, and
    // a plain call tells it the scan's own directory. The scan empties that
    // directory after every call.
    const { report } = await lab(`mount ${home.notes}`);
    expect(row(report, "link_store").calls).toBeGreaterThan(10);
    expect(readdirSync(home.notes)).toEqual(["todo.txt"]);
    expect(readFileSync(path.join(home.notes, "todo.txt"), "utf8")).toBe(
      "todo\n",
    );
    expect(readdirSync(path.join(dir, "data")).sort()).toEqual([
      "exports",
      "notes",
      "other.txt",
    ]);
    expect(readdirSync(dir).sort()).toEqual(["data", "precious.txt"]);
    expect(scanDirs()).toEqual(before);
  });
});

test("a payload names only what the scan made, wherever the tool takes it", async () => {
  await withDir(async (dir) => {
    const home = userHome(dir);
    // sync_notebook makes a copy where it runs, named after its argument,
    // and removes and rewrites the same name in the user's notes. The copy
    // is evidence, and the scan is wrong to trust it. What it then sends
    // still names nothing that was there before.
    const { report } = await lab(`sync ${home.notes}`);
    expect(row(report, "sync_notebook").anchored).toBe(true);
    const calls = `${home.notes}.calls`;
    for (const args of sentTo(calls, "sync_notebook")) {
      expect(Object.hasOwn(args, "name"), JSON.stringify(args)).toBe(true);
      expect(args.name === "" || args.name === "..", JSON.stringify(args)).toBe(
        false,
      );
    }
    // path is required by the schema and has a default in the code. It is
    // never left out, so the user's settings are never the target.
    for (const args of sentTo(calls, "save_settings")) {
      expect(Object.hasOwn(args, "path"), JSON.stringify(args)).toBe(true);
    }
    expect(existsSync(path.join(home.notes, "settings.json"))).toBe(false);
    // Everything that was there is there, with what it held.
    expect(readFileSync(path.join(home.notes, "todo.txt"), "utf8")).toBe(
      "todo\n",
    );
    expect(readFileSync(path.join(dir, "data", "other.txt"), "utf8")).toBe(
      "other\n",
    );
    expect(readFileSync(path.join(dir, "precious.txt"), "utf8")).toBe(
      "precious\n",
    );
    expect(existsSync(path.join(dir, "data", "exports"))).toBe(true);
    // What was added has the scan's name on it. A path in full, joined
    // under the notes, starts with the first part of the temp directory and
    // has the scan's own directory further down.
    const [, tempTop = ""] = realpathSync(os.tmpdir()).split(path.sep);
    const added = [
      ...readdirSync(dir).filter(
        (name) => !["data", "precious.txt"].includes(name),
      ),
      ...readdirSync(path.join(dir, "data")).filter(
        (name) =>
          !["exports", "notes", "notes.calls", "other.txt"].includes(name),
      ),
      ...readdirSync(home.notes).filter((name) => name !== "todo.txt"),
    ];
    for (const name of added) {
      expect(
        name === tempTop || /^(gauntlet-|987654321)/.test(name),
        name,
      ).toBe(true);
    }
  });
});

test("a named pipe left in the scan's directory does not hang it", async () => {
  const before = scanDirs();
  const { report } = await lab("pipe");
  expect(row(report, "make_pipe")).toMatchObject({ plain: "answered" });
  expect(row(report, "make_pipe").calls).toBeGreaterThan(10);
  expect(scanDirs()).toEqual(before);
});

test("a write through a link in the directory is put down to the tool that made it", async () => {
  const { report } = await lab("everywhere");
  const writes = report.findings.filter(
    (finding) => finding.kind === "outside-write",
  );
  // read_note stays in its directory. rewrite_all has no path, and wrote
  // through the links planted there.
  expect(writes.length).toBeGreaterThan(0);
  expect([...new Set(writes.map((finding) => finding.tool))]).toEqual([
    "rewrite_all",
  ]);
  expect(writes[0]?.call).toMatch(
    /^\{"name":"rewrite_all","arguments":\{"search":/,
  );
  expect(
    report.findings.some(
      (finding) => finding.tool === "read_note" && finding.tier === "safety",
    ),
  ).toBe(false);
});

test("a server that checks its arguments and says no in plain text is not marked down", async () => {
  const { code, report } = await lab("softtool");
  expect(report.findings).toEqual([]);
  expect(code).toBe(0);
  expect(row(report, "add").plain).toBe("answered");
});

test("a reply too large to read is said so, and is not a fault", async () => {
  const { code, report } = await lab("big");
  expect(report.findings).toEqual([]);
  expect(code).toBe(0);
  expect(row(report, "take_screenshot")).toMatchObject({ plain: "too large" });
  expect(row(report, "take_screenshot").reason).toContain(
    "a reply was too large to read, and the server was started again",
  );
  expect(row(report, "ping").plain).toBe("answered");
});

test("a directory a call made read-only costs neither the report nor the cleanup", async () => {
  const before = scanDirs();
  const { code, report } = await lab("locked");
  expect(code).toBe(0);
  expect(row(report, "fetch_module").plain).toBe("answered");
  expect(report.leftover).toBeUndefined();
  expect(scanDirs()).toEqual(before);
});

test("a schema made to be expensive does not stop a scan or a plan", async () => {
  const started = Date.now();
  const plan = await lab("wide", "--plan");
  expect(plan.code).toBe(0);
  expect(plan.report.tools.map((tool) => tool.status)).toEqual([
    "planned",
    "planned",
  ]);
  const ran = await lab("wide");
  expect(row(ran.report, "tree").reason).toContain(
    "its schema asks for more values than a scan fills in",
  );
  expect(row(ran.report, "ping").plain).toBe("answered");
  expect(row((await lab("minlength")).report, "pad").plain).toBe("answered");
  expect(Date.now() - started).toBeLessThan(20_000);
});

test("nothing answered is exit 2 whatever notes there are", async () => {
  // An unknown tool gets a result here, so there is a soft-errors note. The
  // one real tool turned its plain call down.
  const { code, report } = await lab("softnone");
  expect(report.findings.map((finding) => finding.kind)).toEqual([
    "soft-errors",
  ]);
  expect(code).toBe(2);
});

test("a scan in which nothing answered is not a clean scan", async () => {
  const result = await run([
    "scan",
    "--mcp",
    `${LAB} none`,
    "--timeout",
    "1500",
  ]);
  expect(result.code).toBe(2);
  expect(result.stdout).toContain(
    "0 of 1 scanned tool answered a plain call.\nNo finding means little for them: a tool that turns every call down gives nothing to find.\n",
  );
  expect(result.stderr).toBe(
    "no tool answered a plain call, so nothing was tested. A tool may need a variable from --env, or the server may want arguments on its command line\n",
  );
  expect((await lab("none", "--fail-on", "none")).code).toBe(0);
});

test("a temp directory a shell would split is refused, not used", async () => {
  await withDir(async (dir) => {
    const spaced = path.join(dir, "my tmp");
    mkdirSync(spaced);
    const child = spawnSync(
      process.execPath,
      [
        "dist/cli.js",
        "scan",
        "--mcp",
        `${NODE} ${process.cwd()}/test/fixtures/mcp-zoo.mjs vulnerable`,
        "--tool",
        "grep_notes",
        "--timeout",
        "1500",
      ],
      { encoding: "utf8", env: { ...process.env, TMPDIR: spaced } },
    );
    // /tmp is plain, so the scan runs there and still finds the injection.
    expect(child.stdout).toContain("shell-injection  grep_notes.pattern");
    expect(readdirSync(dir)).toEqual(["my tmp"]);
    expect(readdirSync(spaced)).toEqual([]);
  });
});

test("an interrupt during a scan leaves no server and no directory", async () => {
  const before = scanDirs();
  const child = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "scan",
      "--mcp",
      `${NODE} ${process.cwd()}/test/fixtures/mcp-zoo.mjs vulnerable`,
      "--tool",
      "wait_for",
      "--timeout",
      "20000",
    ],
    { stdio: "ignore" },
  );
  const servers = (): string[] =>
    spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(
        (line) =>
          /fixtures\/mcp-zoo\.mjs vulnerable/.test(line) &&
          (line.startsWith(process.execPath) || /^(\/bin\/)?sh -c /.test(line)),
      );
  const until = async (done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 6000;
    while (!done() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  // Wait until the scan is inside the hang: a directory and a server exist.
  await until(() => scanDirs().length > before.length && servers().length > 0);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  child.kill("SIGINT");
  expect(await exited).toBe(130);
  await until(
    () => servers().length === 0 && scanDirs().length === before.length,
  );
  expect(servers()).toEqual([]);
  expect(scanDirs()).toEqual(before);
});

test("a tool name from the server cannot draw on the terminal", async () => {
  const esc = String.fromCharCode(0x1b);
  const server = `${NODE} -e "
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      const result = m.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'odd' + String.fromCharCode(27) + '[2J' } }
        : { tools: [{ name: 'wipe' + String.fromCharCode(27) + '[2J' + String.fromCharCode(13) + 'ok', inputSchema: { type: 'object' } }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + String.fromCharCode(10));
    });
  "`;
  const missing = await run(["scan", "--mcp", server, "--tool", "nope"]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).not.toContain(esc);
  expect(missing.stderr).toBe(
    "the MCP server has no tool named nope. Its tools: wipe\\u001b[2J\\u000dok\n",
  );
  const plan = await run(["scan", "--mcp", server, "--plan"]);
  expect(plan.stdout).not.toContain(esc);
  expect(plan.stdout).toContain("server: odd\\u001b[2J\n");
  // --json too. What it prints is still JSON, and reads back as it was.
  const json = await run(["scan", "--mcp", server, "--plan", "--json"]);
  expect(json.stdout).not.toContain(esc);
  expect(json.stdout).not.toContain(String.fromCharCode(13));
  expect((JSON.parse(json.stdout) as Report).server).toBe(`odd${esc}[2J`);
  const fixed = await run([
    "run",
    "--mcp",
    server,
    "--scenario",
    "path-escape",
  ]);
  expect(fixed.code).toBe(2);
  expect(fixed.stderr).not.toContain(esc);
  expect(fixed.stderr).toContain("Its tools: wipe\\u001b[2J\\u000dok.");
});

const values = {
  path: "note.txt",
  dir: "sub",
  fresh: "new.txt",
  url: "http://127.0.0.1:1/ok",
  text: "word",
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
    // A code is not a command.
    ["zip_code", {}, "text"],
    ["error_code", {}, "text"],
    ["expression", {}, "text"],
    ["query", {}, "text"],
    ["name", { description: "Path to the file to read" }, "path"],
    ["where", { description: "The URL to fetch" }, "url"],
    ["title", {}, "text"],
    // Said outright, which counts for more than a name like "input".
    ["input", { description: "The shell command to run" }, "command"],
  ];
  for (const [name, schema, kind] of cases) {
    expect(kindOf(name, schema), name).toBe(kind);
  }
});

test("a plain call has every required argument, with a value that does little", () => {
  const schema = {
    type: "object",
    required: [
      "path",
      "destination",
      "dir",
      "count",
      "pid",
      "recordId",
      "mode",
      "tags",
      "options",
      "force",
      "dryRun",
      "since",
      "url",
      "command",
      "note",
      "who",
    ],
    properties: {
      path: { type: "string" },
      destination: { type: "string" },
      dir: { type: "string" },
      count: { type: "integer", minimum: 5, maximum: 9 },
      pid: { type: "integer" },
      recordId: { type: "integer", maximum: 1000 },
      mode: { type: "string", enum: ["fast", "slow"] },
      tags: { type: "array", items: { type: "string" } },
      options: {
        type: "object",
        required: ["cwd"],
        properties: { cwd: { type: "string" }, extra: { type: "string" } },
      },
      force: { type: "boolean" },
      dryRun: { type: "boolean" },
      since: { type: "string", format: "date-time" },
      url: { type: "string" },
      command: { type: "string" },
      note: { type: ["string", "null"], minLength: 12 },
      who: { $ref: "#/$defs/Person" },
      skipped: { type: "string" },
    },
    $defs: {
      Person: {
        type: "object",
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
      },
    },
  };
  expect(readSchema(schema).plain(values)).toEqual({
    path: "note.txt",
    destination: "new.txt",
    dir: "sub",
    count: 5,
    // An id nothing has, and not 1.
    pid: 987654321,
    recordId: 1000,
    mode: "fast",
    tags: ["word"],
    options: { cwd: "sub" },
    // A switch that forces is left off, and one that does less is on.
    force: false,
    dryRun: true,
    since: "2026-01-01T00:00:00Z",
    url: "http://127.0.0.1:1/ok",
    command: "echo word",
    // A second text argument gets a word of its own.
    note: "word-2gggggg",
    who: { email: "word@example.com" },
  });
  expect(readSchema(undefined).plain(values)).toEqual({});
  expect(readSchema(undefined).described).toBe(false);
  expect(readSchema(schema).described).toBe(true);
  // A name from a schema is a key, never the prototype.
  const proto = readSchema({ required: ["__proto__"], properties: {} }).plain(
    values,
  );
  expect(Object.keys(proto)).toEqual(["__proto__"]);
  expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
});

test("every free string is a place for a payload, and the ones left out are counted", () => {
  const schema = {
    properties: {
      path: { type: "string" },
      mode: { type: "string", enum: ["a"] },
      files: { type: "array", items: { type: "string" } },
      options: { type: "object", properties: { cwd: { type: "string" } } },
      count: { type: "number" },
    },
  };
  const reader = readSchema(schema);
  const args = {
    path: "note.txt",
    mode: "a",
    files: ["x"],
    options: { cwd: "sub" },
    count: 1,
  };
  const { points, skipped } = reader.points(args);
  expect(skipped).toBe(0);
  expect(points.map((point) => [point.label, point.kind])).toEqual([
    ["path", "path"],
    ["files[0]", "path"],
    ["options.cwd", "path"],
  ]);
  const [, files, cwd] = points;
  if (!files || !cwd) throw new Error("missing points");
  expect(withString(args, files.pointer, "P")).toMatchObject({
    files: ["P"],
    path: "note.txt",
  });
  expect(withString(args, cwd.pointer, "P")).toMatchObject({
    options: { cwd: "P" },
  });
  expect(args.files).toEqual(["x"]);

  // An optional object is filled in so that a path inside it is reached.
  const nested = readSchema({
    required: ["a"],
    properties: {
      a: { type: "string" },
      n: { type: "number" },
      cwd: { type: "string" },
      options: {
        type: "object",
        properties: { path: { type: "string" }, depth: { type: "number" } },
      },
    },
  });
  expect(nested.optional(values)).toEqual([
    { name: "cwd", value: "sub" },
    { name: "options", value: { path: "note.txt" } },
  ]);

  const many = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`s${index}`, "x"]),
  );
  const wide = readSchema({}).points(many);
  expect(wide.points).toHaveLength(16);
  expect(wide.skipped).toBe(4);
});

test("a violation is a wrong type, and a missing argument only where that is safe", () => {
  const reader = readSchema({
    required: ["a", "name", "either", "flag", "ref", "pair"],
    properties: {
      a: { type: "number" },
      name: { type: "string" },
      either: { anyOf: [{ type: "string" }, { type: "number" }] },
      flag: { type: "boolean" },
      ref: { $ref: "#/$defs/N" },
      pair: { $ref: "#/properties/either" },
    },
    $defs: { N: { type: "integer" } },
  });
  const base = { a: 1, name: "x", either: "y", flag: false, ref: 2, pair: "z" };
  const never = (): boolean => false;
  // Nothing for either or pair, which allow two types. Nothing for flag: a
  // wrong value for a switch may read as on.
  expect(reader.violations(base, never).map((item) => item.label)).toEqual([
    "a as a string, where the schema says number",
    "name as a number, where the schema says string",
    "ref as a string, where the schema says integer",
  ]);
  const dropped = reader
    .violations(base, (name) => name === "name" || name === "flag")
    .map((item) => item.label);
  expect(dropped).toContain("no name, which the schema requires");
  // A switch is never left out, whoever asks.
  expect(dropped.some((label) => label.includes("flag"))).toBe(false);
  expect(readSchema({}).violations({}, () => true)).toEqual([]);
});

test("no two arguments of a call get the same string", () => {
  const more = { ...values, others: ["b.txt", "c.txt"] };
  const reader = readSchema({
    required: [
      "source",
      "path",
      "file",
      "fourth_file",
      "destination",
      "output",
      "title",
      "body",
      "old_text",
      "new_text",
    ],
    properties: Object.fromEntries(
      [
        "source",
        "path",
        "file",
        "fourth_file",
        "destination",
        "output",
        "title",
        "body",
        "old_text",
        "new_text",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  expect(reader.plain(more)).toEqual({
    source: "note.txt",
    path: "b.txt",
    file: "c.txt",
    // There are three notes. A fourth path shares one, and proves nothing.
    fourth_file: "note.txt",
    destination: "new.txt",
    output: "new-2.txt",
    title: "word",
    body: "word-2",
    old_text: "word-3",
    new_text: "word-new",
  });
  // An optional argument does not take a value a required one has.
  const optional = readSchema({
    required: ["path"],
    properties: { path: { type: "string" }, backup_file: { type: "string" } },
  });
  expect(optional.optional(more)).toEqual([
    { name: "backup_file", value: "b.txt" },
  ]);
});

test("a switch or an option is set to what does least", () => {
  const reader = readSchema({
    required: [
      "dry_run",
      "no_dry_run",
      "skip_safety_check",
      "disable_preview",
      "force",
      "keep",
      "verbose",
      "action",
      "mode",
    ],
    properties: {
      dry_run: { type: "boolean" },
      no_dry_run: { type: "boolean" },
      skip_safety_check: { type: "boolean" },
      disable_preview: { type: "boolean" },
      force: { type: "boolean", default: true },
      keep: { type: "boolean", default: true },
      verbose: { type: "boolean" },
      action: { enum: ["delete_all", "archive", "list"] },
      mode: { enum: ["purge", "overwrite"] },
    },
  });
  expect(reader.plain(values)).toEqual({
    dry_run: true,
    no_dry_run: false,
    skip_safety_check: false,
    disable_preview: false,
    // Left off whatever the schema says its default is.
    force: false,
    keep: true,
    verbose: false,
    action: "list",
    // Nothing here only looks, so the first it is.
    mode: "purge",
  });
});

test("a schema too large to fill in is cut short, not followed to the end", () => {
  const wide = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`p${index}`, { $ref: "#" }]),
    ),
    required: Array.from({ length: 60 }, (_, index) => `p${index}`),
  };
  const reader = readSchema(wide);
  const started = Date.now();
  reader.plain(values);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(reader.truncated()).toBe(true);
  const small = readSchema({
    required: ["a"],
    properties: { a: { type: "string" } },
  });
  small.plain(values);
  expect(small.truncated()).toBe(false);
  const long = readSchema({
    required: ["q"],
    properties: { q: { type: "string", minLength: 600_000_000 } },
  }).plain(values);
  expect(String(long.q).length).toBe(4096);
});

test("a name says whether a tool removes, sends, or spends", () => {
  for (const name of [
    "delete_file",
    "removeAccount",
    "clear_all",
    "cleanup",
    "prune_old",
    "unlink_file",
    "rmdir",
    "deletefile",
    "empty_trash",
    "XMLDelete",
    "DBDrop",
    "stop_server",
    "expire_sessions",
    "send_email",
    "create_post",
    "overwrite_config",
  ]) {
    expect(soundsDestructive(name), name).toBe(true);
  }
  for (const name of [
    "get_post",
    "list_orders",
    "read_email",
    "search_mail",
    "add",
    "write_file",
    "create_directory",
    "fetch_page",
    "checkout_status",
  ]) {
    expect(soundsDestructive(name), name).toBe(false);
  }
});

test("a name says whether a tool only looks", () => {
  for (const name of [
    "get_post",
    "list_orders",
    "read_email",
    "search_mail",
    "grep",
    "fetchPage",
    "describe_table",
  ]) {
    expect(nature(name), name).toBe("reads");
  }
  // A second verb, or one that is never a noun, says it does more.
  for (const name of [
    "check_and_delete",
    "get_and_remove",
    "read_and_clear",
    "fetch_and_prune",
    "list_and_purge",
    "trash_note",
    "discard_changes",
    "git_stash",
    "close_account",
    "trim_history",
  ]) {
    expect(nature(name), name).toBe("removes");
  }
  for (const name of [
    "add",
    "write_file",
    "save_note",
    "create_directory",
    "link_store",
    "sync_notebook",
    "toString",
  ]) {
    expect(nature(name), name).toBe("unknown");
  }
});

test("an option, a switch, and a number get the value that does least", () => {
  const choose = (options: unknown[], name = "mode"): unknown =>
    readSchema({
      required: [name],
      properties: { [name]: { enum: options } },
    }).plain(values)[name];
  expect(choose(["merge", "replace"])).toBe("merge");
  expect(choose(["w", "a"])).toBe("a");
  expect(choose(["read_write", "read_only"])).toBe("read_only");
  expect(choose(["yes", "no"])).toBe("no");
  expect(choose(["true", "false"])).toBe("false");
  expect(choose(["force", "safe"])).toBe("safe");
  expect(choose(["hard", "soft"])).toBe("soft");
  expect(choose(["replace", "append", "fail"])).toBe("append");
  expect(choose(["production", "staging"])).toBe("staging");
  // true and false as an option are a switch.
  expect(choose([true, false], "force")).toBe(false);
  expect(choose([true, false], "dry_run")).toBe(true);

  const names = [
    "read_only",
    "readOnly",
    "keep_existing",
    "check_and_delete",
    "force",
    "clean",
    "offset",
    "max_entries",
    "length",
    "copies",
  ];
  const types: Record<string, string> = {
    force: "integer",
    clean: "integer",
    offset: "integer",
    max_entries: "integer",
    length: "integer",
    copies: "integer",
  };
  const reader = readSchema({
    required: names,
    properties: Object.fromEntries(
      names.map((name) => [name, { type: types[name] ?? "boolean" }]),
    ),
  });
  const built = reader.plain(values);
  expect(built).toEqual({
    read_only: true,
    readOnly: true,
    keep_existing: true,
    // "check" is in it, and so is "delete".
    check_and_delete: false,
    // A switch written as a number.
    force: 0,
    clean: 0,
    // The beginning, and plenty from there.
    offset: 0,
    max_entries: 1000,
    length: 1000,
    copies: 1,
  });
  // None of the switches is given a wrong value, whatever its type.
  expect(
    reader.violations(built, () => false).map((item) => item.label),
  ).toEqual([
    "offset as a string, where the schema says integer",
    "max_entries as a string, where the schema says integer",
    "length as a string, where the schema says integer",
    "copies as a string, where the schema says integer",
  ]);
  // Nor is an option: a wrong value for "overwrite: no" may read as yes.
  const option = readSchema({
    required: ["when", "note"],
    properties: {
      when: { type: "string", enum: ["never", "always"] },
      note: { type: "string" },
    },
  });
  expect(
    option
      .violations({ when: "never", note: "x" }, () => false)
      .map((item) => item.label),
  ).toEqual(["note as a number, where the schema says string"]);
});
