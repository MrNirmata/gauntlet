// reference-naive behind the black-box exec protocol.
import { referenceNaive } from "../../dist/adapters/reference.js";
import { replyText } from "./reply.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const output = await referenceNaive.run({
  raw: input.raw,
  sandboxDir: input.sandboxDir,
  aborted: input.aborted,
});
process.stdout.write(`${replyText(output)}\n`);
