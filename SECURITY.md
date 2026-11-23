# Security

## What Gauntlet runs

Gauntlet runs code you point it at.

- `--adapter <path>` imports that module into the Gauntlet process.
- `--exec "<command>"` runs the command in a shell, once per probe, from the directory you start Gauntlet in.
- `--http <url>` POSTs each probe to that URL.
- `--mcp "<command>"` runs the command in a shell, once per scenario, inside that scenario's temp directory.
- `--adapter nanocoder`, from a git checkout only, clones a pinned commit of Nano-Collective/nanocoder into `third_party/` and imports two of its source files.

Point it at code you would run anyway.

## What a scan does

`gauntlet scan` is different from the rest. It does not send a fixed set of calls to two file tools. It calls the tools the server lists, with arguments it made up from each tool's schema. `gauntlet scan --plan` lists what would be called and calls nothing.

Two reviews of this command ran it against servers written to make it do harm, and each found a way. What follows is what the scan keeps to now, and after it, what it does not.

What it calls:

- With no flag, only a tool the server marks read-only, or one whose name starts by saying it looks: `get_`, `list_`, `read_`, `search_`, and the like. A name with a second verb, or with `delete`, `remove`, `clear` and the like anywhere in it, is not one of those.
- With `--write`, also a tool that nothing marks or names either way.
- With `--destructive`, or when named with `--tool`, also a tool the server marks destructive, one it marks not read-only without saying it is not destructive, one whose name says it removes, sends, or spends, and one that requires an argument named `confirm` or `force`.
- The names of `--tool`, `--skip`, and `--ignore` are checked against the server's list before the first call.

What it sends:

- Every path, relative or in full, names something the scan made: it ends in a name that has `gauntlet-` and the scan's eight random characters in it, or it goes through the scan's own temp directory. It sends no `..` alone, no empty string, no `/`, no `~`, and no path of yours. The value that is 10000 arrays deep has a word at its centre, so a server that flattens it does not get an empty name.
- A required argument is left out only of a tool the server marks read-only.
- A path that leaves a directory is sent only to an argument seen to work in the scan's own directory: the reply held what only the file it named holds, or what it named changed or appeared. A file the server made for itself under another name does not count.
- A switch is set to what its name says does less, and an option to the value whose name says so. An optional switch or option is not added. The calls that break the schema leave switches and options as they were, whatever type the schema gives them.
- The commands it tries to inject only `touch` a file in its temp directory, and the path of that directory has no space or shell character in it. If the system temp directory has one, `/tmp` is used, and if that has one too the scan stops.

What it does with its own files:

- The server's directory is four levels inside the temp directory the scan made. No payload goes further than one level above it.
- A call can replace one of the scan's directories with a symlink to somewhere else. Before the scan lists, writes, or removes anything, it checks from the top down that each directory is a real one, and removes a link that is in its place. It reads only plain files it could have written, not a link, a pipe, or a device.
- When removing its temp directory fails because a call left a read-only directory, it makes the directories writable and tries again. It opens each without following a link and checks that it is inside the temp directory before changing it.
- The server is started with `PATH`, `LANG`, a temp `HOME`, a temp `TMPDIR`, and no other variable of yours. A variable you pass with `--env` is one the server can use on anything.

What it does not limit:

- The server is your code, running as you, with your files and your network. The environment is trimmed. Nothing else is confined.
- A tool that does harm under a name that says it reads, or that the server wrongly marks read-only, is called with no flag at all.
- With `--write`, a tool that writes is asked to write. A tool that imports, merges, or appends does that to whatever store it has. Which value of an option does least is read from names, and a name can mislead: an option the scan takes for harmless may not be.
- A tool can use one argument in two places. One that makes a copy where it runs, named after its argument, and also acts on the same name in a directory of yours, is taken to work in the scan's directory. What it is then sent still names only what the scan made, so it removes nothing of yours, but it can leave files there.
- A server that keeps its data in a fixed place gets calls there, and they leave files and directories in that place. Their names start with `gauntlet-` and the scan's eight characters, or are `987654321`, and some have control characters, quotes, or a shell command after that. A server that makes directories for a path it is given can leave a tree of them, starting with the first part of the temp directory's path.
- A tool that takes an id is given `987654321`, or the largest number its schema allows. If that id exists, the call acts on it.
- A wrong type is still sent: a number where a free string goes, a word where a number goes. What a tool does with that is the tool's.
- A process a tool starts in a group of its own outlives the scan.
- A tool that does its work after it answers is not seen to work in the scan's directory, so its arguments get no path that leaves one.
- A server can still reach the network with whatever a tool does by default.

Scan a server whose worst case you accept, with test credentials or none, and use `--write` and `--destructive` where the server's data is a copy.

A scan with no findings does not mean the server is safe. The scan tries the payloads it has, on the arguments it can see, of the tools it was let call. A tool that turned down its plain call was not exercised, and an argument that was not seen to work in the scan's directory was not sent a path that leaves one. The report's `status`, `plain call`, and `paths` columns say which those are, and a scan in which no tool answered exits 2.

## What the sandbox is

Each scenario gets a new directory under the system temp directory. It holds `workspace/` and `outside.txt`. Gauntlet deletes it when the scenario ends.

It is a fixture, not a jail. Nothing stops an adapter from writing somewhere else. The payloads are built to stay inside that directory when an adapter follows them blindly: a traversal goes one level up, to a file Gauntlet created. Run an adapter you do not trust in a container or a VM.

The payloads are the test. They contain path traversal, a NUL byte, bidi controls, and a prompt injection. They are in `src/scenarios/`, and `gauntlet show <id>` prints them.

## What a pass means

A pass means the adapter handled the payloads in this suite. It is not a proof that the adapter is safe. `reference-hardened` passed all 12 scenarios of 0.1 and still had the holes listed in CHANGELOG.md.

Some failures cannot be a scenario, and `reference-hardened` does not stop them:

- A symlink swapped between the path check and the open. It needs a second process writing in the workspace while the tool runs. Stopping it takes an open that cannot leave a directory, such as `openat2` with `RESOLVE_BENEATH`. The reference MCP filesystem server pins the directory and opens with `O_NOFOLLOW` for this.
- A read through a hard link to a file outside the workspace. Many workspaces hold hard links on purpose, pnpm's `node_modules` among them, so refusing every read of one is not a fix.
- A name in another alphabet that looks like `notes.txt`. A Cyrillic `о` is a letter.
- An MCP server that passes because it did nothing. The control call before a run catches a server that refuses everything. It does not catch one that works for `gauntlet-control.txt` and refuses every other name.
- Names that are one file to the filesystem and two to a string compare: `NOTES.TXT` on macOS and Windows, and on Windows `notes.txt.` and `notes.txt::$DATA`.

## What the tiers and the CWE ids mean

`safety` and `robustness` are how this project sorts its own scenarios. The CWE id on a scenario names the weakness a failure points at. It is a classification made here. It is not a CVE, and MITRE did not assign it to any product.

A failed safety scenario in a SARIF report is an `error`. That is a default, and the reader of the report decides what it costs in their system.

## Report a vulnerability

Report a vulnerability in Gauntlet through a private advisory: https://github.com/MrNirmata/gauntlet/security/advisories/new

A parser that fails a scenario is a bug in that parser. Report it to that project. A payload that gets past `reference-hardened` is a missing scenario. Open a scenario proposal issue.
