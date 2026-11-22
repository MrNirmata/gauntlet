#!/usr/bin/env python3
"""Hardened tool-call adapter for Gauntlet black-box mode.

    gauntlet run --exec "python3 examples/python-hardened.py"

Passes every scenario with the Python standard library. python-adapter.py is
the naive version of the same program. Read the two side by side.

Reads one JSON object from stdin:

    {"raw": "<model output>", "sandboxDir": "/path/to/workspace", "aborted": false}

Writes one JSON object to stdout: executed or refused.

Two things it does not stop. A symlink swapped between the path check and the
open still wins the race. A read through a hard link to a file outside the
workspace still reads that file.
"""

import json
import os
import re
import stat
import sys
import unicodedata

MAX_RAW_BYTES = 65536
MAX_DEPTH = 64

# Only the four JSON whitespace characters are padding. str.strip() also
# removes U+0085 and the separators U+001C to U+001F, and stripping those
# turns a path that should be refused into the name of a file that exists.
PADDING = " \t\r\n"

# Letters and marks that draw as nothing: fillers, variation selectors, the
# combining grapheme joiner, the braille blank, the object replacement.
BLANK = (
    (0x034F, 0x034F),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x2800, 0x2800),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFFA0, 0xFFA0),
    (0xFFFC, 0xFFFC),
    (0xE0100, 0xE01EF),
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
        # Anything but a plain false is an aborted stream.
        output = execute(raw, sandbox, request.get("aborted") is not False)
    except Refused as refusal:
        output = {"status": "refused", "reason": str(refusal)}
    # Nothing is written before this line can succeed: the arguments are no
    # deeper than MAX_DEPTH, hold no NaN, and every string is valid Unicode.
    sys.stdout.write(json.dumps(output, allow_nan=False))
    sys.stdout.write("\n")


def execute(raw: str, sandbox: str, aborted: bool) -> dict:
    if aborted:
        raise Refused("stream aborted before the tool call finished")
    if not well_formed(raw):
        raise Refused("payload is not valid Unicode")
    if len(raw.encode("utf-8")) > MAX_RAW_BYTES:
        raise Refused(f"argument exceeds {MAX_RAW_BYTES} bytes")
    if raw.lstrip(PADDING).startswith("<"):
        name, arguments = parse_xml(raw)
    else:
        name, arguments = parse_json(raw)
    if name not in ("read_file", "write_file"):
        raise Refused("unknown tool")
    for key in ("path", "encoding"):
        if isinstance(arguments.get(key), str):
            arguments[key] = arguments[key].strip(PADDING)
    user_path = arguments.get("path")
    content = arguments.get("content")
    if not isinstance(user_path, str):
        raise Refused("missing argument")
    if name == "write_file" and not isinstance(content, str):
        raise Refused("missing argument")
    encoding = arguments.get("encoding", "utf-8")
    if not isinstance(encoding, str) or encoding.lower() not in ("utf-8", "utf8"):
        raise Refused("encoding not allowed")
    target = resolve_inside(sandbox, user_path)
    call = {"name": name, "arguments": arguments}
    # A tool that fails hands the failure back as its result. newline="" keeps
    # line endings as they are, and bytes that are not UTF-8 read as U+FFFD.
    try:
        if name == "read_file":
            if not os.path.isfile(target):
                return {"status": "executed", "call": call, "result": "error: not found"}
            with open(target, encoding="utf-8", errors="replace", newline="") as handle:
                return {"status": "executed", "call": call, "result": handle.read()}
        guard_write(target, content)
        with open(target, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
        return {"status": "executed", "call": call, "result": "wrote"}
    except OSError as error:
        return {"status": "executed", "call": call, "result": f"error: {error.strerror}"}


def guard_write(target: str, content: str) -> None:
    # A lone surrogate has no UTF-8 form, and the open below would have
    # emptied the file before the write found that out. Opening a FIFO for
    # writing blocks until something reads it. A file with a second hard link
    # may be the same file as one outside the workspace.
    if not well_formed(content):
        raise Refused("content is not valid Unicode")
    try:
        info = os.stat(target)
    except OSError:
        return
    if not stat.S_ISREG(info.st_mode):
        raise Refused("write target is not a regular file")
    if info.st_nlink > 1:
        raise Refused("write target has more than one hard link")


def well_formed(text: str) -> bool:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


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
        value = json.loads(
            strip_trailing_commas(text),
            object_pairs_hook=unique_keys,
            parse_constant=not_json,
        )
    except json.JSONDecodeError:
        raise Refused("truncated or invalid JSON") from None
    except RecursionError:
        raise Refused("nesting too deep") from None
    except ValueError:
        # An integer with more digits than int() converts.
        raise Refused("number out of range") from None
    check(value)
    return value


def not_json(name: str):
    # json.loads reads NaN and Infinity. They are not JSON.
    raise Refused("truncated or invalid JSON")


def unique_keys(pairs: list) -> dict:
    record = {}
    for key, value in pairs:
        if key in record:
            raise Refused("duplicate key")
        record[key] = value
    return record


def check(value) -> None:
    # Walk the parsed value with a list, not with recursion. The reply holds
    # these arguments, and json.dumps recurses, so a value it cannot print
    # has to be refused before a tool runs.
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        if isinstance(item, float) and (item != item or item in (float("inf"), float("-inf"))):
            raise Refused("number out of range")
        if not isinstance(item, (dict, list)):
            continue
        if depth > MAX_DEPTH:
            raise Refused("nesting too deep")
        children = item.values() if isinstance(item, dict) else item
        pending.extend((child, depth + 1) for child in children)


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
            ahead = index + 1
            while ahead < len(text) and text[ahead] in PADDING:
                ahead += 1
            closes = text[ahead : ahead + 1] in ("}", "]")
            if closes and last not in ("", "{", "[", ","):
                continue
        if char not in PADDING:
            last = char
        out.append(char)
    return "".join(out)


def parse_xml(raw: str) -> tuple:
    text = raw.strip(PADDING)
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
        rest = rest.lstrip(PADDING)
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


def odd_character(user_path: str):
    # Every "other" category: controls, format characters such as zero-width
    # and bidi marks, lone surrogates, private use, and unassigned. Every
    # separator that is not the plain space. Then the blanks.
    invisible = False
    for char in user_path:
        code = ord(char)
        if code < 0x20 or 0x7F <= code <= 0x9F:
            return "path contains control characters"
        category = unicodedata.category(char)
        if category[0] == "C" or category in ("Zl", "Zp"):
            invisible = True
        elif category == "Zs" and char != " ":
            invisible = True
        elif any(first <= code <= last for first, last in BLANK):
            invisible = True
    return "path contains invisible characters" if invisible else None


def resolve_inside(workspace: str, user_path: str) -> str:
    if not user_path:
        raise Refused("empty path")
    odd = odd_character(user_path)
    if odd is not None:
        raise Refused(odd)
    if os.path.isabs(user_path) or re.match(r"^([A-Za-z]:|[\\/])", user_path):
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
    try:
        inside = os.path.commonpath([real_workspace, real_anchor]) == real_workspace
    except ValueError:
        inside = False
    if not inside:
        raise Refused("symlink escapes workspace")
    # notes.txt/x: the part that is on disk is a file, and the rest of the
    # path would have to be inside it. On macOS that names a resource fork.
    if anchor != resolved and not os.path.isdir(real_anchor):
        raise Refused("path goes through a file")
    return resolved


if __name__ == "__main__":
    main()
