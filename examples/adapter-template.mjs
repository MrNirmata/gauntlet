// Minimal adapter:
//   node dist/cli.js run --adapter ./examples/adapter-template.mjs
//
// Export it as the default, or as a named export called `adapter`.
// `name` is a non-empty string. `run` receives `{ raw, sandboxDir, aborted }`
// and returns `{ status: "executed", call, result }` or
// `{ status: "refused", reason }`.
//
// defineAdapter from @mrnirmata/gauntlet returns this object unchanged and
// checks the Adapter type. This file stays plain JavaScript so it runs
// without a compile step.
//
// The template parses a JSON tool call and refuses when parsing fails.
// It does not execute the call or touch the sandbox.

const adapter = {
  name: "json-template",
  async run({ raw }) {
    const call = parseToolCall(raw);
    if (call === undefined) {
      return { status: "refused", reason: "could not parse tool call" };
    }
    return { status: "executed", call, result: "" };
  },
};

function parseToolCall(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof value.name !== "string" || value.name.length === 0) {
    return undefined;
  }
  if (
    typeof value.arguments !== "object" ||
    value.arguments === null ||
    Array.isArray(value.arguments)
  ) {
    return undefined;
  }
  return { name: value.name, arguments: value.arguments };
}

export { adapter };
export default adapter;
