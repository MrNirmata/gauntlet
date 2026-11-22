// MCP servers that misbehave, one way each. Every one of them reads and
// writes a file in its own directory, so it gets past the control call that
// comes before a run. The odd behavior is for the calls after that.
//
//   node mcp-odd.mjs <mode>
//
// banner       prints a line that is not JSON, then pings the client
// crash        exits 3 on a tools/call
// hang         never answers a tools/call
// no-start     exits 4 before it answers initialize
// rpc-error    answers a tools/call with a JSON-RPC error
// null-id      answers a tools/call with a parse error that has a null id
// paged        lists its tools over two pages, and has no write_file
// many-pages   never stops listing tools
// refuse-all   turns every call down, the control call too
// leak         has no jail, and returns what it read inside an isError result
// resource     returns what it read as an embedded resource block
// structured   returns what it read as structuredContent only
// header       returns what it read behind a header line, in two blocks
// stubborn     works, and stays alive when its input closes
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2];
const CONTROL = "gauntlet-control.txt";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value, isError = false) => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

if (mode === "no-start") {
  process.stderr.write("cannot open the allowed directory\n");
  process.exit(4);
}
if (mode === "banner") process.stdout.write("Secure server running on stdio\n");
if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

function shaped(body) {
  if (mode === "resource") {
    return {
      content: [
        { type: "resource", resource: { uri: "file:///x", text: body } },
      ],
    };
  }
  if (mode === "structured")
    return { content: [], structuredContent: { text: body } };
  if (mode === "header") {
    return {
      content: [
        { type: "text", text: "1 file" },
        { type: "text", text: body.trim() },
      ],
    };
  }
  return text(body);
}

// A plain file tool with no jail.
function run(name, args) {
  try {
    if (name === "read_file") return shaped(readFileSync(args.path, "utf8"));
    if (name === "write_file") {
      writeFileSync(args.path, args.content);
      return text("wrote");
    }
    return text(`unknown tool ${name}`, true);
  } catch (error) {
    return text(error.message, true);
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === undefined) continue;
  if (message.id === undefined) {
    if (mode === "banner" && message.method === "notifications/initialized") {
      send({ jsonrpc: "2.0", id: "srv-1", method: "ping" });
      send({ jsonrpc: "2.0", id: "srv-2", method: "roots/list" });
      send({ jsonrpc: "2.0", method: "notifications/message", params: {} });
    }
    continue;
  }
  const ok = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    ok({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "odd", version: "0" },
    });
  } else if (message.method === "tools/list") {
    const tool = (name) => ({ name, inputSchema: { type: "object" } });
    if (mode === "many-pages") {
      ok({ tools: [tool("list")], nextCursor: "more" });
    } else if (mode === "paged") {
      ok(
        message.params?.cursor === "next"
          ? { tools: [tool("read_file")] }
          : { tools: [tool("list")], nextCursor: "next" },
      );
    } else {
      ok({ tools: [tool("read_file"), tool("write_file")] });
    }
  } else if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params;
    if (mode === "refuse-all") {
      ok(text("Invalid arguments: file_path is required", true));
      continue;
    }
    if (args.path === CONTROL) {
      ok(run(name, args));
      continue;
    }
    if (mode === "crash") {
      process.stderr.write("RangeError: Maximum call stack size exceeded\n");
      process.exit(3);
    }
    if (mode === "hang") continue;
    if (mode === "rpc-error") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "Invalid arguments\nsecond line" },
      });
      continue;
    }
    if (mode === "null-id") {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }
    if (mode === "leak" && name === "read_file") {
      const result = run(name, args);
      ok({ ...result, isError: true });
      continue;
    }
    ok(run(name, args));
  }
}
