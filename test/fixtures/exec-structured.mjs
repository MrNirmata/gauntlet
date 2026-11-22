// A black-box adapter that takes the parsed call, not the raw text. It
// refuses to work from raw alone, and it checks that the call it was given
// has the keys the scenario wrote, __proto__ included.
import { readFileSync } from "node:fs";
import { referenceHardened } from "../../dist/index.js";
import { replyText } from "./reply.mjs";

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
  // Work from the call alone. The raw text is only read above, to check
  // that the call is the same call.
  let fromCall;
  try {
    fromCall = JSON.stringify({
      name: request.call.name,
      arguments: request.call.arguments,
    });
  } catch {
    fromCall = undefined;
  }
  output =
    fromCall === undefined
      ? { status: "refused", reason: "nesting too deep" }
      : await referenceHardened.run({
          raw: fromCall,
          sandboxDir: request.sandboxDir,
          aborted: request.aborted,
        });
}
process.stdout.write(`${replyText(output)}\n`);
