// A black-box adapter that takes the parsed call, not the raw text. It
// refuses to work from raw alone, and it checks that the call it was given
// has the keys the scenario wrote, __proto__ included.
import { readFileSync } from "node:fs";
import { referenceHardened } from "../../dist/index.js";

const request = JSON.parse(readFileSync(0, "utf8"));
let output;
if (request.call === undefined) {
  output = { status: "not-covered", reason: "no call in the probe" };
} else {
  const written = Object.keys(JSON.parse(request.raw).arguments).join(",");
  const given = Object.keys(request.call.arguments).join(",");
  if (written !== given || JSON.parse(request.raw).name !== request.call.name) {
    throw new Error(`call was changed on the way: ${written} became ${given}`);
  }
  output = await referenceHardened.run({
    raw: request.raw,
    sandboxDir: request.sandboxDir,
    aborted: request.aborted,
  });
}
// Deep nesting comes back in the call. Leave that one argument out of the
// reply, so printing the reply does not need the stack the scenario is about.
if (output.status === "executed") delete output.call.arguments.filter;
process.stdout.write(`${JSON.stringify(output)}\n`);
