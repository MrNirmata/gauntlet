// Prints an adapter's output as one JSON line.
//
// An executed output carries the call back, and for deep-nesting that call
// is 10000 arrays deep. JSON.stringify recurses, and on Node 22 and 24 that
// is deeper than its stack. The test doubles are not what the scenario is
// testing, so they leave the arguments out when they cannot be printed.
export function replyText(output) {
  try {
    return JSON.stringify(output);
  } catch (error) {
    if (!(error instanceof RangeError) || output.status !== "executed") {
      throw error;
    }
    return JSON.stringify({
      ...output,
      call: { name: output.call.name, arguments: {} },
    });
  }
}
