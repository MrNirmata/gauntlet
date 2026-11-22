// An MCP server with one tool for each thing a scan looks for.
//
//   node mcp-zoo.mjs <vulnerable|safe>
//
// In vulnerable mode each tool has the flaw its comment names. In safe mode
// the same tools are written the way the scan's fix lines say, and a scan
// has nothing to report.
import { execFileSync, execSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const safe = process.argv[2] === "safe";
const root = realpathSync(process.cwd());

const text = (value, isError = false) => ({
  content: [{ type: "text", text: String(value) }],
  ...(isError ? { isError: true } : {}),
});
const refuse = (reason) => text(reason, true);
const string = { type: "string" };
const number = { type: "number" };
const schema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

// The directory the server was started in, links followed.
function inside(given) {
  if (typeof given !== "string" || given.length === 0 || given.includes("\0")) {
    throw new Error("not a path");
  }
  const resolved = path.resolve(root, given);
  let anchor = resolved;
  for (;;) {
    try {
      anchor = realpathSync(anchor);
      break;
    } catch {
      const parent = path.dirname(anchor);
      if (parent === anchor) throw new Error("no such path");
      anchor = parent;
    }
  }
  const relative = path.relative(root, anchor);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("outside the allowed directory");
  }
  return resolved;
}

function needString(value, name) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

const tools = {
  // Reads any path it is given.
  read_note: {
    description: "Read a note.",
    inputSchema: schema({ path: string }, ["path"]),
    run: ({ path: given }) =>
      text(
        readFileSync(
          safe ? inside(given) : path.resolve(root, String(given)),
          "utf8",
        ),
      ),
  },
  // Writes any path it is given.
  save_note: {
    description: "Save a note under a name.",
    inputSchema: schema({ name: string, text: string }, ["name", "text"]),
    run: ({ name, text: body }) => {
      const target = safe ? inside(name) : path.resolve(root, String(name));
      writeFileSync(target, safe ? needString(body, "text") : String(body));
      return text("saved");
    },
  },
  // Lists any directory. The directory is optional.
  list_notes: {
    description: "List the notes, or the notes in a directory.",
    inputSchema: schema(
      { dir: { type: "string", description: "Directory path" } },
      [],
    ),
    run: ({ dir }) => {
      const where =
        dir === undefined
          ? root
          : safe
            ? inside(dir)
            : path.resolve(root, String(dir));
      return text(readdirSync(where).join("\n"));
    },
  },
  // Puts its argument into a shell command.
  grep_notes: {
    description: "Search the notes.",
    inputSchema: schema({ pattern: string }, ["pattern"]),
    run: ({ pattern }) => {
      try {
        return text(
          safe
            ? execFileSync(
                "grep",
                ["-r", "-e", needString(pattern, "pattern"), "."],
                { encoding: "utf8" },
              )
            : execSync(`grep -r ${pattern} .`, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }),
        );
      } catch {
        return text("no match");
      }
    },
  },
  // Follows a file:// address, and fetches addresses on this machine.
  fetch_page: {
    description: "Fetch a page.",
    inputSchema: schema({ url: string }, ["url"]),
    run: async ({ url }) => {
      const address = new URL(needString(url, "url"));
      if (address.protocol === "file:") {
        if (safe) throw new Error("only http and https");
        return text(readFileSync(fileURLToPath(address), "utf8"));
      }
      if (address.protocol !== "http:" && address.protocol !== "https:") {
        throw new Error("only http and https");
      }
      if (safe && address.pathname !== "/ok")
        throw new Error("address not allowed");
      const response = await fetch(address);
      return text(await response.text());
    },
  },
  // Does not check its arguments against its schema.
  add: {
    description: "Add two numbers.",
    inputSchema: schema({ a: number, b: number }, ["a", "b"]),
    run: (args) => {
      if (safe) {
        const extra = Object.keys(args).filter(
          (key) => key !== "a" && key !== "b",
        );
        if (
          typeof args.a !== "number" ||
          typeof args.b !== "number" ||
          extra.length > 0
        ) {
          throw new Error("a and b must be numbers");
        }
      }
      return text(args.a + args.b);
    },
  },
  // Exits when its string is an array.
  title_case: {
    description: "Put a title in title case.",
    inputSchema: schema({ text: string }, ["text"]),
    run: ({ text: given }) => {
      if (Array.isArray(given) && !safe) {
        process.stderr.write(
          "RangeError: Maximum call stack size exceeded\n",
          () => process.exit(7),
        );
        return new Promise(() => {});
      }
      return text(needString(given, "text").toUpperCase().slice(0, 100));
    },
  },
  // Never answers a long string.
  wait_for: {
    description: "Wait for a word to appear.",
    inputSchema: schema({ text: string }, ["text"]),
    run: ({ text: given }) => {
      if (needString(given, "text").length > 100_000) {
        if (safe) throw new Error("text is too long");
        return new Promise(() => {});
      }
      return text("seen");
    },
  },
  // Runs a command. That is what it is for, in both modes.
  run_shell: {
    description: "Run a shell command in the notes directory.",
    inputSchema: schema({ command: string }, ["command"]),
    run: ({ command }) => {
      try {
        return text(
          execSync(needString(command, "command"), {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2000,
          }),
        );
      } catch {
        return refuse("the command failed");
      }
    },
  },
  // Turns every call down until it is given a key, like a tool that needs
  // credentials. With one, it says what it can see of the environment.
  needs_key: {
    description: "Search the web.",
    inputSchema: schema({ query: string }, ["query"]),
    run: () =>
      process.env.ZOO_KEY === undefined
        ? refuse("missing API key")
        : text(
            `searched with a key, home is ${process.env.HOME}, secret is ${process.env.ZOO_SECRET ?? "unset"}`,
          ),
  },
  // Marked destructive. It leaves a file behind if it is ever called.
  drop_all: {
    description: "Delete every note.",
    inputSchema: schema({}, []),
    annotations: { destructiveHint: true },
    run: () => {
      writeFileSync(path.join(root, "drop-all-was-called"), "x");
      return text("dropped");
    },
  },
};

// vulnerable: a plain lookup, which also finds constructor and toString.
function find(name) {
  if (safe) return Object.hasOwn(tools, name) ? tools[name].run : undefined;
  const found = tools[name];
  if (found === undefined) return undefined;
  return typeof found.run === "function"
    ? found.run
    : () => text(String(found));
}

// safe: the arguments are what the published schema says, or the call is
// turned down before the tool runs.
function check(name, args) {
  const { properties, required } = tools[name].inputSchema;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("arguments must be an object");
  }
  for (const key of required) {
    if (!Object.hasOwn(args, key)) throw new Error(`${key} is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = properties[key]?.type;
    if (expected === undefined) throw new Error(`${key} is not an argument`);
    if (typeof value !== expected)
      throw new Error(`${key} must be a ${expected}`);
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim().length === 0) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    continue;
  }
  if (message.id === undefined) continue;
  const ok = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    ok({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "zoo", version: safe ? "safe" : "vulnerable" },
    });
  } else if (message.method === "tools/list") {
    ok({
      tools: Object.entries(tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    });
  } else if (message.method === "tools/call") {
    const run = find(message.params.name);
    if (run === undefined) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: `Unknown tool ${message.params.name}` },
      });
      continue;
    }
    try {
      const args = message.params.arguments ?? {};
      if (safe) check(message.params.name, args);
      ok(await run(args));
    } catch (error) {
      ok(refuse(error instanceof Error ? error.message : String(error)));
    }
  } else {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }
}
