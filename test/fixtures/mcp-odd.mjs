// MCP servers that misbehave, one way each.
//
//   node mcp-odd.mjs <mode>
//
// banner    prints a line that is not JSON, then pings the client, then works
// crash     exits 3 on the first tools/call
// hang      never answers tools/call
// no-start  exits 4 before it answers initialize
// rpc-error answers tools/call with a JSON-RPC error
// paged     lists its tools over two pages, and has no write_file
import { createInterface } from "node:readline";

const mode = process.argv[2];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (mode === "no-start") {
  process.stderr.write("cannot open the allowed directory\n");
  process.exit(4);
}
if (mode === "banner") process.stdout.write("Secure server running on stdio\n");

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
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "odd", version: "0" },
      },
    });
  } else if (message.method === "tools/list") {
    if (mode === "paged") {
      const second = message.params?.cursor === "next";
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: second
          ? { tools: [{ name: "read_file", inputSchema: { type: "object" } }] }
          : {
              tools: [{ name: "list", inputSchema: { type: "object" } }],
              nextCursor: "next",
            },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: ["read_file", "write_file"].map((name) => ({
            name,
            inputSchema: { type: "object" },
          })),
        },
      });
    }
  } else if (message.method === "tools/call") {
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
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "hello\n" }] },
    });
  }
}
