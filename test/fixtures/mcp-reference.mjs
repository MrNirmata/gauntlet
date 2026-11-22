// A small MCP server over stdio for the tests. It answers initialize,
// tools/list, and tools/call, and hands each call to a reference adapter.
//
//   node mcp-reference.mjs <naive|hardened> <workspace> [renamed]
//
// With "renamed" it offers read_text_file and write_text_file.
import { createInterface } from "node:readline";
import { referenceHardened, referenceNaive } from "../../dist/index.js";

const adapter =
  process.argv[2] === "naive" ? referenceNaive : referenceHardened;
const workspace = process.argv[3] ?? process.cwd();
const renamed = process.argv[4] === "renamed";
const names = renamed
  ? { read_text_file: "read_file", write_text_file: "write_file" }
  : { read_file: "read_file", write_file: "write_file" };

function reply(id, body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
}

async function call(params) {
  const ours = Object.hasOwn(names, params.name)
    ? names[params.name]
    : params.name;
  let raw;
  try {
    raw = JSON.stringify({ name: ours, arguments: params.arguments });
  } catch {
    return {
      content: [{ type: "text", text: "nesting too deep" }],
      isError: true,
    };
  }
  const output = await adapter.run({
    raw,
    sandboxDir: workspace,
    aborted: false,
  });
  if (output.status === "executed") {
    return { content: [{ type: "text", text: output.result }] };
  }
  return { content: [{ type: "text", text: output.reason }], isError: true };
}

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim().length === 0) continue;
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    reply(message.id, {
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "gauntlet-test-server", version: "0" },
      },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, {
      result: {
        tools: Object.keys(names).map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      },
    });
  } else if (message.method === "tools/call") {
    reply(message.id, { result: await call(message.params) });
  } else {
    reply(message.id, { error: { code: -32601, message: "Method not found" } });
  }
}
