// MCP servers for the cases a scan has to get right, one mode each.
//
//   node mcp-lab.mjs <mode> [path]
//
// datadir <dir>   keeps its notes in <dir>, not in the directory it runs in
// log <file>      appends the name of every tool that is called to <file>
// errtext         turns a call down with a plain result, never with isError
// anyof           checks its arguments exactly; one of them takes two types
// shell           one tool runs commands by design, one puts a code in a command
// absolute        takes only paths written in full, and checks them badly
// clear           removes whatever path it is given
// background      runs its argument in a shell a moment after it answers
// none            every tool turns every call down
// forms           each tool works with one form of path only, and has no jail
import { execSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2];
const extra = process.argv[3];
const cwd = process.cwd();
const string = { type: "string" };
const schema = (properties, required) => ({
  type: "object",
  properties,
  required,
});
const text = (value, isError = false) => ({
  content: [{ type: "text", text: String(value) }],
  ...(isError ? { isError: true } : {}),
});
const refuse = (reason) =>
  mode === "errtext" ? text(`Error: ${reason}`) : text(reason, true);
const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };

const sets = {
  datadir: {
    read_note: {
      inputSchema: schema({ name: string }, ["name"]),
      run: ({ name }) =>
        text(readFileSync(path.resolve(extra, String(name)), "utf8")),
    },
    save_note: {
      inputSchema: schema({ name: string, text: string }, ["name", "text"]),
      run: ({ name, text: body }) => {
        writeFileSync(path.resolve(extra, String(name)), String(body));
        return text("saved");
      },
    },
    list_notes: {
      inputSchema: schema({}, []),
      run: () => text(readdirSync(extra).join("\n")),
    },
    // A short path goes to the data directory. A path in full goes where
    // it says.
    put_file: {
      inputSchema: schema({ path: string, content: string }, [
        "path",
        "content",
      ]),
      run: ({ path: given, content }) => {
        writeFileSync(path.resolve(extra, String(given)), String(content));
        return text("written");
      },
    },
  },
  log: Object.fromEntries(
    ["delete_everything", "send_email", "list_things", "removeAccount"].map(
      (name) => [
        name,
        {
          inputSchema: schema(
            name === "send_email" ? { to: string, body: string } : {},
            name === "send_email" ? ["to", "body"] : [],
          ),
          run: () => {
            appendFileSync(extra, `${name}\n`);
            return text("done");
          },
        },
      ],
    ),
  ),
  errtext: {
    add: {
      inputSchema: schema({ a: { type: "number" }, b: { type: "number" } }, [
        "a",
        "b",
      ]),
      run: ({ a, b }) =>
        typeof a === "number" && typeof b === "number"
          ? text(a + b)
          : refuse("a and b must be numbers"),
    },
  },
  anyof: {
    set_value: {
      inputSchema: schema(
        { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
        ["value"],
      ),
      run: ({ value }) =>
        typeof value === "string" || typeof value === "number"
          ? text("set")
          : refuse("value must be a string or a number"),
    },
    toggle: {
      inputSchema: schema({ on: { type: "boolean" } }, ["on"]),
      run: ({ on }) =>
        typeof on === "boolean"
          ? text("toggled")
          : refuse("on must be a boolean"),
    },
  },
  shell: {
    bash: {
      description: "Run a shell command.",
      inputSchema: schema(
        { input: { type: "string", description: "The shell command to run" } },
        ["input"],
      ),
      run: ({ input }) => {
        try {
          return text(execSync(String(input), { ...quiet, timeout: 2000 }));
        } catch {
          return refuse("the command failed");
        }
      },
    },
    // "code" is in the argument's name. It is still put into a command.
    geo_lookup: {
      description: "Look up a place by its postal code.",
      inputSchema: schema({ zip_code: string }, ["zip_code"]),
      run: ({ zip_code }) => {
        try {
          return text(
            execSync(`echo ${zip_code}`, { ...quiet, timeout: 2000 }),
          );
        } catch {
          return refuse("lookup failed");
        }
      },
    },
  },
  absolute: {
    read_file: {
      inputSchema: schema({ path: string }, ["path"]),
      run: ({ path: given }) => {
        if (typeof given !== "string" || !path.isAbsolute(given))
          return refuse("path must be absolute");
        if (!given.startsWith(`${cwd}/`))
          return refuse("path is outside the allowed directory");
        return text(readFileSync(given, "utf8"));
      },
    },
  },
  clear: {
    clear_path: {
      inputSchema: schema({ path: string }, ["path"]),
      run: ({ path: given }) => {
        rmSync(path.resolve(cwd, String(given)), {
          recursive: true,
          force: true,
        });
        return text("cleared");
      },
    },
  },
  background: {
    queue_search: {
      inputSchema: schema({ query: string }, ["query"]),
      run: ({ query }) => {
        setTimeout(() => {
          try {
            execSync(`echo ${query}`, { ...quiet, timeout: 2000 });
          } catch {
            // The search failed. Nobody is waiting for it.
          }
        }, 300);
        return text("queued");
      },
    },
    ping: { inputSchema: schema({}, []), run: () => text("pong") },
  },
  forms: {
    // Lists a directory, and nothing else.
    list_dir: {
      inputSchema: schema({ path: string }, ["path"]),
      run: ({ path: given }) =>
        text(readdirSync(path.resolve(cwd, String(given))).join("\n")),
    },
    // Makes a directory that is not there yet.
    make_dir: {
      inputSchema: schema({ path: string }, ["path"]),
      run: ({ path: given }) => {
        mkdirSync(path.resolve(cwd, String(given)));
        return text("made");
      },
    },
    // Replaces one text with another, and fails when the first is not there.
    replace_text: {
      inputSchema: schema(
        { path: string, old_text: string, new_text: string },
        ["path", "old_text", "new_text"],
      ),
      run: ({ path: given, old_text, new_text }) => {
        const file = path.resolve(cwd, String(given));
        const body = readFileSync(file, "utf8");
        if (!body.includes(String(old_text))) return refuse("text not found");
        writeFileSync(file, body.replace(String(old_text), String(new_text)));
        return text("replaced");
      },
    },
    // Returns a file as an image block, which is base64.
    read_blob: {
      inputSchema: schema({ path: string }, ["path"]),
      run: ({ path: given }) => ({
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: readFileSync(path.resolve(cwd, String(given))).toString(
              "base64",
            ),
          },
        ],
      }),
    },
    // Says where a file is and how big. It never returns what is in one.
    stat_file: {
      inputSchema: schema({ path: string }, ["path"]),
      run: ({ path: given }) => text(`${String(given).length} characters`),
    },
  },
  none: {
    search: {
      inputSchema: schema({ query: string }, ["query"]),
      run: () => refuse("missing API key"),
    },
  },
};

const tools = sets[mode] ?? {};
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
      serverInfo: { name: "lab", version: mode },
    });
  } else if (message.method === "tools/list") {
    ok({
      tools: Object.entries(tools).map(([name, tool]) => ({
        name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      })),
    });
  } else if (message.method === "tools/call") {
    const tool = Object.hasOwn(tools, message.params.name)
      ? tools[message.params.name]
      : undefined;
    if (!tool) {
      if (mode === "errtext") ok(refuse(`unknown tool ${message.params.name}`));
      else
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: `Unknown tool ${message.params.name}`,
          },
        });
      continue;
    }
    try {
      ok(await tool.run(message.params.arguments ?? {}));
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
