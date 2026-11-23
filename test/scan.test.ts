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
import { kindOf, readSchema, withString } from "../src/scan/schema.ts";

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

const scan = (mode: string, ...rest: string[]) =>
  scanWith(`${ZOO} ${mode}`, ...rest);
const lab = (mode: string, ...rest: string[]) =>
  scanWith(`${LAB} ${mode}`, ...rest);

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
    expect(row(report, name).calls, name).toBeGreaterThan(3);
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
    "--name",
    "zoo",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(
    /^scan: zoo\nserver: zoo safe\n\ntool +status +calls +plain call +strings +findings\n/,
  );
  expect(result.stdout).toMatch(/\nneeds_key +scanned +\d+ +refused +1 +0\n/);
  expect(result.stdout).toMatch(
    /\ndrop_all +skipped +- +- +- +- +the server marks it destructive\n/,
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

    // --plan lists what would be called and calls nothing.
    const plan = await run(["scan", "--mcp", `${LAB} log ${log}`, "--plan"]);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toMatch(/\nlist_things +planned +- +- +0 +-\n/);
    expect(plan.stdout).toMatch(
      /\nsend_email +skipped +- +- +- +- +its name says it removes, sends, or spends\n/,
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
      "safety outside-write replace_text path",
    ].sort(),
  );
  // A directory, a name that is not there yet, a file whose text changes,
  // and a file that comes back as base64.
  for (const name of ["list_dir", "make_dir", "replace_text", "read_blob"]) {
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
      "paths that leave a directory were not sent: the plain call was not seen to work in the scan's directory",
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
});

test("shell payloads go to every string, and a tool that runs commands is not an injection", async () => {
  const { report } = await lab("shell");
  // zip_code has "code" in its name. It is still put into a command.
  expect(kinds(report)).toEqual([
    "robustness schema-not-enforced geo_lookup",
    "safety shell-injection geo_lookup zip_code",
  ]);
  expect(row(report, "bash").findings).toBe(0);
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
  const { code, report } = await lab("clear");
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
    note: "wordgggggggg",
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

test("a violation is a wrong type or a missing required argument", () => {
  const reader = readSchema({
    required: ["a", "name", "either", "flag", "ref"],
    properties: {
      a: { type: "number" },
      name: { type: "string" },
      either: { anyOf: [{ type: "string" }, { type: "number" }] },
      flag: { type: "boolean" },
      ref: { $ref: "#/$defs/N" },
    },
    $defs: { N: { type: "integer" } },
  });
  const base = { a: 1, name: "x", either: "y", flag: false, ref: 2 };
  expect(reader.violations(base, false).map((item) => item.label)).toEqual([
    "a as a string, where the schema says number",
    "name as a number, where the schema says string",
    // Not "yes": a lenient validator reads that as true.
    "flag as a string, where the schema says boolean",
    "ref as a string, where the schema says integer",
  ]);
  expect(
    reader.violations(base, false).find((item) => item.label.startsWith("flag"))
      ?.arguments,
  ).toMatchObject({ flag: "gauntlet" });
  expect(reader.violations(base, true).map((item) => item.label)).toContain(
    "no either, which the schema requires",
  );
  expect(readSchema({}).violations({}, true)).toEqual([]);
});
