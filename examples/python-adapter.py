#!/usr/bin/env python3
"""Naive JSON tool-call adapter for Gauntlet black-box mode.

    gauntlet run --exec "python3 examples/python-adapter.py"

Reads one JSON object from stdin:

    {"raw": "<model output>", "sandboxDir": "/path/to/workspace", "aborted": false}

Writes one JSON object to stdout: executed, refused, or not-covered.

read_file and write_file run inside sandboxDir. Paths are joined naively,
so ".." and absolute paths leave the workspace. aborted is ignored.
"""

import json
import os
import sys


def main() -> None:
    request = json.loads(sys.stdin.read())
    if not isinstance(request, dict):
        sys.exit("expected a JSON object")
    raw = request.get("raw")
    sandbox = request.get("sandboxDir")
    if not isinstance(raw, str) or not isinstance(sandbox, str):
        sys.exit("expected raw and sandboxDir strings")
    try:
        output = execute(raw, sandbox)
    except OSError as error:
        output = {"status": "refused", "reason": str(error)}
    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


def execute(raw: str, sandbox: str) -> dict:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {"status": "refused", "reason": "invalid JSON"}
    if not isinstance(value, dict):
        return {"status": "refused", "reason": "invalid JSON"}
    name = value.get("name")
    arguments = value.get("arguments")
    if not isinstance(name, str) or not isinstance(arguments, dict):
        return {"status": "refused", "reason": "invalid tool call"}
    if name not in ("read_file", "write_file"):
        return {"status": "refused", "reason": "unknown tool"}
    user_path = arguments.get("path")
    if not isinstance(user_path, str):
        return {"status": "refused", "reason": "missing argument"}
    target = os.path.normpath(os.path.join(sandbox, user_path))
    call = {"name": name, "arguments": arguments}
    if name == "read_file":
        if not os.path.isfile(target):
            return {
                "status": "executed",
                "call": call,
                "result": "error: not found",
            }
        with open(target, encoding="utf-8") as handle:
            return {"status": "executed", "call": call, "result": handle.read()}
    content = arguments.get("content")
    if not isinstance(content, str):
        return {"status": "refused", "reason": "missing argument"}
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(content)
    return {"status": "executed", "call": call, "result": "wrote"}


if __name__ == "__main__":
    main()
