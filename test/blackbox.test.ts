import { spawnSync } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { referenceNaive } from "../src/adapters/reference.ts";
import { runCli } from "../src/cli.ts";
import type { AdapterRunInput } from "../src/types.ts";

const python3 = spawnSync("python3", ["--version"], { encoding: "utf8" });

test("exec adapter matches reference-naive", async () => {
  const command = nodeCommand(path.join("test", "fixtures", "exec-naive.mjs"));
  const naive = await run(["run", "--adapter", "reference-naive", "--json"]);
  const exec = await run(["run", "--exec", command, "--json"]);
  expect(exec.stderr).toBe("");
  expect(exec.code).toBe(naive.code);
  const naiveReport = readRun(naive.stdout);
  const execReport = readRun(exec.stdout);
  expect(execReport.adapter).toBe(`exec:${command}`);
  expect(execReport.scenarios).toEqual(naiveReport.scenarios);
});

test("exec stdin protocol sends one JSON probe", async () => {
  for (const [id, aborted] of [
    ["truncated-json", "false"],
    ["stream-aborted", "true"],
  ] as const) {
    const result = await run([
      "run",
      "--exec",
      nodeCommand(path.join("test", "fixtures", "exec-protocol.mjs"), aborted),
      "--scenario",
      id,
      "--json",
    ]);
    expect(result.stderr, id).toBe("");
    const report = readRun(result.stdout);
    expect(report.scenarios[0]?.status, id).toBe("error");
    expect(report.scenarios[0]?.reason, id).toBe("exec exited 1: protocol-ok");
  }
});

test("exec timeout yields error", async () => {
  const result = await run([
    "run",
    "--exec",
    "sleep 30",
    "--timeout",
    "1000",
    "--scenario",
    "truncated-json",
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  const report = readRun(result.stdout);
  expect(report.scenarios).toHaveLength(1);
  expect(report.scenarios[0]?.status).toBe("error");
  expect(report.scenarios[0]?.reason).toBe("exec timed out after 1000ms");
});

test("exec garbage stdout yields error", async () => {
  const command = nodeEval('process.stdout.write("not-json\\n")');
  const result = await run([
    "run",
    "--exec",
    command,
    "--scenario",
    "truncated-json",
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  const report = readRun(result.stdout);
  expect(report.adapter).toBe(`exec:${command}`);
  expect(report.scenarios[0]?.status).toBe("error");
  expect(report.scenarios[0]?.reason).toBe("exec output was not valid JSON");
});

test("exec non-zero exit yields error", async () => {
  const noise = `bad news ${"n".repeat(400)}`;
  const command = nodeEval(
    `process.stderr.write(${JSON.stringify(noise)}); process.exit(4)`,
  );
  const result = await run([
    "run",
    "--exec",
    command,
    "--scenario",
    "truncated-json",
    "--json",
  ]);
  expect(result.code).toBe(1);
  const report = readRun(result.stdout);
  expect(report.scenarios[0]?.status).toBe("error");
  expect(report.scenarios[0]?.reason).toBe(
    `exec exited 4: ${noise.slice(0, 200)}`,
  );
});

test("exec output that is not a RunOutput yields error", async () => {
  const command = nodeEval(
    `process.stdout.write(${JSON.stringify('{"status":"executed"}')})`,
  );
  const result = await run([
    "run",
    "--exec",
    command,
    "--name",
    "boxed",
    "--scenario",
    "truncated-json",
    "--json",
  ]);
  const report = readRun(result.stdout);
  expect(report.adapter).toBe("boxed");
  expect(report.scenarios[0]?.status).toBe("error");
  expect(report.scenarios[0]?.reason).toBe("exec output was not a RunOutput");
});

test("http adapter matches reference-naive", async () => {
  const sockets: Socket[] = [];
  const server = createServer((req, res) => {
    void serveNaive(req, res);
  });
  server.on("connection", (socket) => {
    sockets.push(socket);
  });
  const port = await listen(server);
  try {
    const naive = await run(["run", "--adapter", "reference-naive", "--json"]);
    const http = await run([
      "run",
      "--http",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);
    expect(http.stderr).toBe("");
    expect(http.code).toBe(naive.code);
    const naiveReport = readRun(naive.stdout);
    const httpReport = readRun(http.stdout);
    expect(httpReport.adapter).toBe(`http:http://127.0.0.1:${port}`);
    expect(httpReport.scenarios).toEqual(naiveReport.scenarios);
  } finally {
    await closeServer(server, sockets);
  }
});

test("http garbage and timeout yield error", async () => {
  const garbageSockets: Socket[] = [];
  const garbage = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not-json");
  });
  garbage.on("connection", (socket) => {
    garbageSockets.push(socket);
  });
  const garbagePort = await listen(garbage);
  try {
    const result = await run([
      "run",
      "--http",
      `http://127.0.0.1:${garbagePort}`,
      "--scenario",
      "truncated-json",
      "--json",
    ]);
    expect(result.code).toBe(1);
    const report = readRun(result.stdout);
    expect(report.scenarios[0]?.status).toBe("error");
    expect(report.scenarios[0]?.reason).toBe(
      "http output was not valid JSON: not-json",
    );
  } finally {
    await closeServer(garbage, garbageSockets);
  }

  const hangSockets: Socket[] = [];
  const hanging = createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
  });
  hanging.on("connection", (socket) => {
    hangSockets.push(socket);
  });
  const hangPort = await listen(hanging);
  try {
    const result = await run([
      "run",
      "--http",
      `http://127.0.0.1:${hangPort}`,
      "--timeout",
      "1000",
      "--scenario",
      "truncated-json",
      "--json",
    ]);
    expect(result.code).toBe(1);
    const report = readRun(result.stdout);
    expect(report.scenarios[0]?.status).toBe("error");
    expect(report.scenarios[0]?.reason).toBe("http timed out after 1000ms");
  } finally {
    await closeServer(hanging, hangSockets);
  }
});

test("adapter, exec, and http conflict exits 2", async () => {
  const conflicts = [
    ["run", "--adapter", "reference-naive", "--exec", "true"],
    ["run", "--exec", "true", "--http", "http://127.0.0.1"],
    ["run", "--http", "http://127.0.0.1", "--adapter", "reference-naive"],
    ["run", "--adapter", "a", "--exec", "b", "--http", "http://127.0.0.1"],
  ];
  for (const argv of conflicts) {
    const result = await run(argv);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.stdout, argv.join(" ")).toBe("");
    expect(result.stderr, argv.join(" ")).toBe(
      "--adapter, --exec, and --http are mutually exclusive\n",
    );
  }
  const missing = await run(["run", "--json"]);
  expect(missing.code).toBe(2);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toBe("missing --adapter, --exec, or --http\n");
});

test.skipIf(python3.status !== 0)(
  "python example executes tool calls in the sandbox",
  async () => {
    const result = await run([
      "run",
      "--exec",
      "python3 examples/python-adapter.py",
      "--json",
    ]);
    expect(result.stderr).toBe("");
    const report = readRun(result.stdout);
    expect(report.adapter).toBe("exec:python3 examples/python-adapter.py");
    expect(report.scenarios.some((row) => row.status === "error")).toBe(false);
    const status = new Map(report.scenarios.map((row) => [row.id, row.status]));
    expect(status.get("truncated-json")).toBe("pass");
    expect(status.get("prompt-injection-result")).toBe("pass");
    expect(status.get("unicode-zero-width-path")).toBe("fail");
    expect(status.get("stream-aborted")).toBe("fail");
    expect(status.get("path-escape")).toBe("fail");
  },
);

test.skipIf(python3.status !== 0)(
  "hardened python example passes every scenario",
  async () => {
    const result = await run([
      "run",
      "--exec",
      "python3 examples/python-hardened.py",
      "--json",
    ]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = readRun(result.stdout);
    for (const row of report.scenarios) {
      expect(row.status, `${row.id}: ${row.reason}`).toBe("pass");
    }
  },
);

async function serveNaive(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const input = readProbe(await readBody(req));
    const output = await referenceNaive.run(input);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(output));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(error instanceof Error ? error.message : String(error));
  }
}

function readProbe(text: string): AdapterRunInput {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("raw" in value) ||
    !("sandboxDir" in value) ||
    !("aborted" in value) ||
    typeof value.raw !== "string" ||
    typeof value.sandboxDir !== "string" ||
    typeof value.aborted !== "boolean"
  ) {
    throw new Error("probe was not an object");
  }
  return {
    raw: value.raw,
    sandboxDir: value.sandboxDir,
    aborted: value.aborted,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("http fixture did not bind");
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server, sockets: Socket[]): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function nodeCommand(script: string, ...args: readonly string[]): string {
  return [shellQuote(process.execPath), script, ...args].join(" ");
}

function nodeEval(source: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function run(argv: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runCli(argv, stdout.stream, stderr.stream);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

type Row = { id: string; status: string; reason: string };

function readRun(text: string): { adapter: string; scenarios: Row[] } {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new Error("report was not an object");
  }
  if (!("adapter" in value) || typeof value.adapter !== "string") {
    throw new Error("report missing adapter");
  }
  if (!("scenarios" in value) || !Array.isArray(value.scenarios)) {
    throw new Error("report missing scenarios");
  }
  const scenarios: Row[] = [];
  for (const row of value.scenarios) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("id" in row) ||
      !("status" in row) ||
      !("reason" in row) ||
      typeof row.id !== "string" ||
      typeof row.status !== "string" ||
      typeof row.reason !== "string"
    ) {
      throw new Error("scenario row had the wrong shape");
    }
    scenarios.push({ id: row.id, status: row.status, reason: row.reason });
  }
  return { adapter: value.adapter, scenarios };
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
