#!/usr/bin/env python3
"""Hardened tool-call adapter for Gauntlet black-box mode.

    gauntlet run --exec "python3 examples/python-hardened.py"

Passes every scenario with the Python standard library. python-adapter.py is
the naive version of the same program. Read the two side by side.

Reads one JSON object from stdin:

    {"raw": "<model output>", "sandboxDir": "/path/to/workspace", "aborted": false}

Writes one JSON object to stdout: executed or refused.
"""

import json
import os
import re
import sys

MAX_RAW_BYTES = 65536

# Zero-width and joiner characters, bidi marks, embeddings, overrides and
# isolates, invisible operators, and the soft hyphen.
INVISIBLE = set(
    [0x00AD, 0x061C, 0x180E, 0xFEFF]
    + list(range(0x200B, 0x2010))
    + list(range(0x202A, 0x202F))
    + list(range(0x2060, 0x2065))
    + list(range(0x2066, 0x2070))
)

OPEN_TAG = re.compile(r"<([a-z0-9_]+)>")


class Refused(Exception):
    pass


def main() -> None:
    request = json.loads(sys.stdin.read())
    if not isinstance(request, dict):
        sys.exit("expected a JSON object")
    raw = request.get("raw")
    sandbox = request.get("sandboxDir")
    if not isinstance(raw, str) or not isinstance(sandbox, str):
        sys.exit("expected raw and sandboxDir strings")
    try:
        output = execute(raw, sandbox, request.get("aborted") is True)
    except Refused as refusal:
        output = {"status": "refused", "reason": str(refusal)}
    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


def execute(raw: str, sandbox: str, aborted: bool) -> dict:
    if aborted:
        raise Refused("stream aborted before the tool call finished")
    if len(raw.encode("utf-8", "surrogatepass")) > MAX_RAW_BYTES:
        raise Refused(f"argument exceeds {MAX_RAW_BYTES} bytes")
    if raw.lstrip().startswith("<"):
        name, arguments = parse_xml(raw)
    else:
        name, arguments = parse_json(raw)
    if name not in ("read_file", "write_file"):
        raise Refused("unknown tool")
    for key in ("path", "encoding"):
        if isinstance(arguments.get(key), str):
            arguments[key] = arguments[key].strip()
    user_path = arguments.get("path")
    content = arguments.get("content")
    if not isinstance(user_path, str):
        raise Refused("missing argument")
    if name == "write_file" and not isinstance(content, str):
        raise Refused("missing argument")
    if arguments.get("encoding", "utf-8") != "utf-8":
        raise Refused("encoding not allowed")
    target = resolve_inside(sandbox, user_path)
    call = {"name": name, "arguments": arguments}
    # A tool that fails hands the failure back as its result.
    try:
        if name == "read_file":
            if not os.path.isfile(target):
                return {"status": "executed", "call": call, "result": "error: not found"}
            with open(target, encoding="utf-8") as handle:
                return {"status": "executed", "call": call, "result": handle.read()}
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(content)
        return {"status": "executed", "call": call, "result": "wrote"}
    except OSError as error:
        return {"status": "executed", "call": call, "result": f"error: {error.strerror}"}


def parse_json(raw: str) -> tuple:
    value = loads(raw)
    if not isinstance(value, dict):
        raise Refused("truncated or invalid JSON")
    name = value.get("name")
    arguments = value.get("arguments")
    # Some providers send arguments as a JSON string. Decode it one level
    # only. A string that decodes to another string is refused.
    if isinstance(arguments, str):
        arguments = loads(arguments)
    if not isinstance(name, str) or not isinstance(arguments, dict):
        raise Refused("truncated or invalid JSON")
    return name, arguments


def loads(text: str):
    # The duplicate check runs inside the parse that produces the value. A
    # scan in front of json.loads would be a second parser, and any text the
    # two read differently would be a way past the scan.
    try:
        return json.loads(strip_trailing_commas(text), object_pairs_hook=unique_keys)
    except json.JSONDecodeError:
        raise Refused("truncated or invalid JSON") from None
    except RecursionError:
        raise Refused("nesting too deep") from None


def unique_keys(pairs: list) -> dict:
    record = {}
    for key, value in pairs:
        if key in record:
            raise Refused("duplicate key")
        record[key] = value
    return record


def strip_trailing_commas(text: str) -> str:
    # A comma is trailing only outside a string, after an item, and before a
    # closer. ",}" inside a value stays, and so does the comma in "{,}".
    out = []
    in_string = False
    escaped = False
    last = ""
    for index, char in enumerate(text):
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == ",":
            rest = text[index + 1 :].lstrip(" \t\r\n")
            if rest[:1] in ("}", "]") and last not in ("", "{", "[", ","):
                continue
        if char not in " \t\r\n":
            last = char
        out.append(char)
    return "".join(out)


def parse_xml(raw: str) -> tuple:
    text = raw.strip()
    root = OPEN_TAG.match(text)
    if root is None:
        raise Refused("invalid XML")
    name = root.group(1)
    close = f"</{name}>"
    if not text.endswith(close):
        raise Refused("truncated or invalid XML")
    rest = text[root.end() : len(text) - len(close)]
    arguments = {}
    while True:
        rest = rest.lstrip()
        if not rest:
            return name, arguments
        tag = OPEN_TAG.match(rest)
        if tag is None:
            raise Refused("text between XML parameters")
        key = tag.group(1)
        end = rest.find(f"</{key}>")
        if end < 0:
            raise Refused("truncated or invalid XML")
        if key in arguments:
            raise Refused("duplicate parameter")
        arguments[key] = rest[tag.end() : end]
        rest = rest[end + len(key) + 3 :]


def resolve_inside(workspace: str, user_path: str) -> str:
    if not user_path:
        raise Refused("empty path")
    for char in user_path:
        code = ord(char)
        if code < 0x20 or code == 0x7F:
            raise Refused("path contains control characters")
        if code in INVISIBLE:
            raise Refused("path contains invisible characters")
    if os.path.isabs(user_path) or re.match(r"^([A-Za-z]:)?[\\/]", user_path):
        raise Refused("absolute path rejected")
    if ".." in re.split(r"[\\/]", user_path):
        raise Refused("parent segment rejected")
    resolved = os.path.normpath(os.path.join(workspace, user_path))
    # Follow the links from the deepest part of the path that is on disk.
    # lexists sees a symlink whose target is missing, and realpath returns
    # that missing target, so a dangling link is judged by where it points.
    anchor = resolved
    while not os.path.lexists(anchor):
        parent = os.path.dirname(anchor)
        if parent == anchor:
            raise Refused("path escapes workspace")
        anchor = parent
    real_workspace = os.path.realpath(workspace)
    real_anchor = os.path.realpath(anchor)
    if os.path.commonpath([real_workspace, real_anchor]) != real_workspace:
        raise Refused("symlink escapes workspace")
    return resolved


if __name__ == "__main__":
    main()
