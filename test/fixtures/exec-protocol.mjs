let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  body += chunk;
});
process.stdin.on("end", () => {
  const input = JSON.parse(body);
  const expected = process.argv[2] === "true";
  const problems = [];
  if (!body.endsWith("\n")) problems.push("newline");
  if (typeof input.raw !== "string") problems.push("raw");
  if (typeof input.sandboxDir !== "string") problems.push("sandboxDir");
  if (input.aborted !== expected) problems.push("aborted");
  if (process.cwd() !== input.sandboxDir) problems.push("cwd");
  process.stderr.write(
    problems.length === 0 ? "protocol-ok" : problems.join(","),
  );
  process.exit(1);
});
