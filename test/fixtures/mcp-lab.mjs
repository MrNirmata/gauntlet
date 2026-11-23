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
// cwdlog <dir>    keeps its notes in <dir>, and writes a log where it runs
// mixed <dir>     reads one argument where it runs and writes the other in <dir>
// choices <file>  logs the arguments of every call to <file>
// marks           tools marked and named in ways a scan has to read
// softtool        checks its arguments, and turns a bad call down in plain text
// big             one tool returns five megabytes
// locked          one tool leaves a directory that cannot be written
// wide            a schema with 60 required properties, each the schema again
// minlength       a string that must be 600 million characters long
// mount <dir>     one tool puts a symlink to <dir> where it is told
// sync <dir>      tools that use an argument where they run and in <dir> too
// pipe            one tool makes a named pipe
// everywhere      one tool rewrites every file it can reach, links followed
// softnone        answers an unknown tool with a result, and no real call
import { execFileSync, execSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
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
  mode === "errtext" || mode === "softtool"
    ? text(`Error: ${reason}`)
    : text(reason, true);
const number = { type: "number" };
const boolean = { type: "boolean" };
const done = () => text("done");
const bare = (annotations) => ({
  inputSchema: schema({}, []),
  run: done,
  ...(annotations ? { annotations } : {}),
});
// 60 required properties, each a reference to the whole schema.
const wide = {
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [`p${index}`, { $ref: "#" }]),
  ),
  required: Array.from({ length: 60 }, (_, index) => `p${index}`),
};
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
    // What a schema library writes for a type used twice: the second use
    // points at the first.
    set_pair: {
      inputSchema: schema(
        {
          a: { anyOf: [{ type: "string" }, { type: "number" }] },
          b: { $ref: "#/properties/a" },
        },
        ["a", "b"],
      ),
      run: ({ a, b }) =>
        [a, b].every((item) => ["string", "number"].includes(typeof item))
          ? text("set")
          : refuse("a and b must be a string or a number"),
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
    // Takes a command. Running it is what the tool is for.
    launch: {
      description: "Start a background process and return its pid.",
      inputSchema: schema({ command: string }, ["command"]),
      run: ({ command }) => {
        if (typeof command !== "string") return refuse("command must be text");
        try {
          return text(execSync(command, { ...quiet, timeout: 2000 }));
        } catch {
          return refuse("the command failed");
        }
      },
    },
    // Its description says "command". The command is its own, and the
    // argument is put into it.
    file_history: {
      description: "Runs the git log command for one file and returns it.",
      inputSchema: schema({ file: string }, ["file"]),
      run: ({ file }) => {
        try {
          return text(
            execSync(`echo log ${file}`, { ...quiet, timeout: 2000 }),
          );
        } catch {
          return refuse("no history");
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
    edit_text: {
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
  cwdlog: {
    read_note: {
      inputSchema: schema({ name: string }, ["name"]),
      run: ({ name }) =>
        text(readFileSync(path.join(extra, String(name ?? "")), "utf8")),
    },
    save_note: {
      inputSchema: schema({ name: string, text: string }, ["name", "text"]),
      run: ({ name, text: body }) => {
        writeFileSync(path.join(extra, String(name ?? "")), String(body));
        return text("saved");
      },
    },
    // Removes what it is given, and all of it when it is given nothing.
    tidy: {
      inputSchema: schema({ name: string }, ["name"]),
      run: ({ name }) => {
        let given = name;
        while (Array.isArray(given)) given = given[0];
        rmSync(path.join(extra, String(given ?? "")), {
          recursive: true,
          force: true,
        });
        return text("tidied");
      },
    },
  },
  mixed: {
    // Reads source where the server runs, and puts it in the data directory
    // under name, in place of whatever was there.
    import_note: {
      inputSchema: schema({ source: string, name: string }, ["source", "name"]),
      run: ({ source, name }) => {
        const body = readFileSync(path.resolve(cwd, String(source)), "utf8");
        const target = path.join(extra, String(name));
        rmSync(target, { recursive: true, force: true });
        writeFileSync(target, body);
        return text(body);
      },
    },
  },
  choices: {
    manage_notes: {
      inputSchema: schema(
        { action: { type: "string", enum: ["delete_all", "archive", "list"] } },
        ["action"],
      ),
      run: done,
    },
    sync_things: {
      inputSchema: schema(
        {
          skip_safety_check: boolean,
          no_dry_run: boolean,
          disable_preview: boolean,
          dry_run: boolean,
          force: boolean,
          keep: { type: "boolean", default: true },
        },
        [
          "skip_safety_check",
          "no_dry_run",
          "disable_preview",
          "dry_run",
          "force",
          "keep",
        ],
      ),
      run: done,
    },
    count_rows: {
      inputSchema: schema({ table: string, limit: number }, ["table", "limit"]),
      run: done,
    },
    // Optional, and not a place for a payload. A scan has no reason to add
    // either, and one of them is what makes the tool act.
    load_notes: {
      inputSchema: schema(
        {
          source: string,
          strategy: { type: "string", enum: ["replace", "merge"] },
          confirm: { const: "yes" },
        },
        ["source"],
      ),
      run: done,
    },
  },
  marks: {
    clear_all: bare(),
    cleanup: bare(),
    prune_old: bare(),
    deletefile: bare(),
    XMLDelete: bare(),
    DBDrop: bare(),
    stop_server: bare(),
    expire_sessions: bare(),
    // Not read-only, and nothing said about destructive: the default is yes.
    sync_state: bare({ readOnlyHint: false }),
    apply_plan: bare({ readOnlyHint: true, destructiveHint: true }),
    // Says outright that it is safe.
    delete_cache: bare({ destructiveHint: false }),
    // A name that starts by saying it only looks.
    get_post: bare(),
    list_orders: bare(),
    read_email: bare(),
    // A real tool with a name every object has.
    toString: bare(),
    // Will not run unless it is told the caller means it.
    seed_store: {
      inputSchema: schema({ confirm: { type: "string", enum: ["yes"] } }, [
        "confirm",
      ]),
      run: done,
    },
    // Looks, and then does not only look.
    list_and_purge: bare(),
  },
  softtool: {
    add: {
      inputSchema: schema({ a: number, b: number }, ["a", "b"]),
      run: ({ a, b }) =>
        typeof a === "number" && typeof b === "number"
          ? text(a + b)
          : refuse("a and b must be numbers"),
    },
  },
  big: {
    take_screenshot: {
      inputSchema: schema({}, []),
      run: () => ({
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "A".repeat(5 * 1024 * 1024),
          },
        ],
      }),
    },
    ping: { inputSchema: schema({}, []), run: () => text("pong") },
  },
  locked: {
    // What a package manager does: a cache in HOME that is read-only.
    fetch_module: {
      inputSchema: schema({}, []),
      run: () => {
        const cache = path.join(process.env.HOME, "pkg", "mod@v1.0.0");
        mkdirSync(cache, { recursive: true });
        writeFileSync(path.join(cache, "go.mod"), "module mod\n", {
          mode: 0o444,
        });
        chmodSync(cache, 0o555);
        chmodSync(path.dirname(cache), 0o555);
        return text("fetched");
      },
    },
  },
  wide: {
    tree: { inputSchema: wide, run: done },
    ping: { inputSchema: schema({}, []), run: () => text("pong") },
  },
  minlength: {
    pad: {
      inputSchema: schema({ q: { type: "string", minLength: 600_000_000 } }, [
        "q",
      ]),
      run: done,
    },
  },
  mount: {
    // Makes the store show up where the server runs.
    link_store: {
      inputSchema: schema({ folder: string }, ["folder"]),
      run: ({ folder }) => {
        const at = path.resolve(cwd, String(folder));
        rmSync(at, { recursive: true, force: true });
        symlinkSync(extra, at);
        return text("linked");
      },
    },
  },
  sync: {
    // A working copy where the server runs, and the store in <dir>.
    sync_notebook: {
      inputSchema: schema({ name: string }, ["name"]),
      run: ({ name }) => {
        const local = path.resolve(cwd, String(name));
        const store = path.join(extra, String(name));
        if (!existsSync(local)) {
          mkdirSync(local);
          return text("pulled");
        }
        rmSync(store, { recursive: true, force: true });
        cpSync(local, store, { recursive: true });
        return text("pushed");
      },
    },
    // The schema requires path. The code has a default all the same.
    save_settings: {
      inputSchema: schema({ path: string, content: string }, [
        "path",
        "content",
      ]),
      run: ({ path: given, content }) => {
        writeFileSync(
          given === undefined
            ? path.join(extra, "settings.json")
            : path.resolve(cwd, String(given)),
          String(content),
        );
        return text("saved");
      },
    },
  },
  pipe: {
    make_pipe: {
      inputSchema: schema({ path: string }, ["path"]),
      run: ({ path: given }) => {
        execFileSync("mkfifo", [path.resolve(cwd, String(given))]);
        return text("made");
      },
    },
  },
  everywhere: {
    // Stays in its directory, links followed.
    read_note: {
      inputSchema: schema({ path: string }, ["path"]),
      run: ({ path: given }) => {
        const real = realpathSync(path.resolve(cwd, String(given)));
        if (!real.startsWith(`${realpathSync(cwd)}${path.sep}`))
          return refuse("outside the directory");
        return text(readFileSync(real, "utf8"));
      },
    },
    // No path at all. It walks the directory with stat, which follows links.
    rewrite_all: {
      inputSchema: schema({ search: string, replacement: string }, [
        "search",
        "replacement",
      ]),
      run: ({ search, replacement }) => {
        const walk = (directory, depth) => {
          if (depth > 3) return;
          for (const name of readdirSync(directory)) {
            const file = path.join(directory, name);
            if (statSync(file).isDirectory()) walk(file, depth + 1);
            else
              writeFileSync(
                file,
                readFileSync(file, "utf8").replaceAll(
                  String(search),
                  String(replacement),
                ),
              );
          }
        };
        walk(cwd, 0);
        return text("rewritten");
      },
    },
  },
  softnone: {
    search: {
      inputSchema: schema({ query: string }, ["query"]),
      run: () => text("missing API key", true),
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
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    });
  } else if (message.method === "tools/call") {
    const tool = Object.hasOwn(tools, message.params.name)
      ? tools[message.params.name]
      : undefined;
    if (!tool) {
      if (mode === "errtext") ok(refuse(`unknown tool ${message.params.name}`));
      else if (mode === "softnone") ok(text("no such tool"));
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
    if (["choices", "cwdlog", "mixed", "sync"].includes(mode)) {
      // What a server would make of the arguments, nested arrays included.
      const seen = Object.fromEntries(
        Object.entries(message.params.arguments ?? {}).map(([key, value]) => {
          let inner = value;
          while (Array.isArray(inner)) inner = inner[0];
          return [key, inner === undefined ? "" : inner];
        }),
      );
      appendFileSync(
        mode === "choices" ? extra : `${extra}.calls`,
        `${message.params.name} ${JSON.stringify(seen)}\n`,
      );
    }
    if (mode === "cwdlog") appendFileSync("server.log", "a call\n");
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
