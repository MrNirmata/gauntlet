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

What limits the harm of a made-up call:

- The server is started in a temp directory with `PATH`, `LANG`, a temp `HOME`, a temp `TMPDIR`, and no other variable of yours, so a tool that needs a token has none. A variable you pass with `--env` is one the server can use on anything.
- A tool is left alone when the server marks it destructive, when the server marks it not read-only and does not say it is not destructive, or when its name says it removes, sends, or spends. `--destructive`, or naming the tool with `--tool`, calls it.
- The names of `--tool`, `--skip`, and `--ignore` are checked against the server's list before the first call. A misspelled `--skip` does not go on to call the tool it was meant to leave out.
- A path that leaves a directory is sent only to an argument that was seen to work in the scan's own directory: the reply held what only the file it named holds, or what it named changed or appeared. It is decided for each argument, not for the tool. A file the server made for itself does not count. Without that evidence the server may keep its data somewhere else, and `../x` would be read against that place.
- The server's directory is four levels inside the temp directory the scan made. No payload goes further than one level above it, which is still inside.
- Every name the scan makes up starts with `gauntlet-` and eight random characters. It sends no empty string, no `/`, no `~`, and no path of yours. The value that is 10000 arrays deep has a word at its centre, so a server that flattens it does not get an empty name. The commands it tries to inject only `touch` a file in its temp directory, and the path of that directory has no space or shell character in it. If the system temp directory has one, `/tmp` is used, and if that has one too the scan stops.
- A switch is set to what does less, and the calls that break the schema leave every switch as it was. An option with a list of values gets one that only looks, when there is one.
- A required argument is left out only of a tool the server marks read-only, or of an argument seen to name a file in the scan's directory. A missing argument is what a tool is most likely to read as "all of them".

What it does not limit:

- The server is your code, running as you, with your files and your network. The environment is trimmed. Nothing else is confined.
- A tool that does harm under a name the scan does not recognise, and that the server does not mark, is called. Most servers mark nothing.
- A server that keeps its data in a fixed place gets calls there. They leave files and directories in that place. Their names start with `gauntlet-` and the scan's eight characters, or are `987654321`, and some have control characters, quotes, or a shell command after that. A server that makes directories for a path it is given can leave a tree of them, named after the scan's own temp path.
- A tool that takes an id is given `987654321`, or the largest number its schema allows. If that id exists, the call acts on it.
- A wrong type is still sent: a number where a string goes, a word where a number goes. What a tool does with that is the tool's.
- A process a tool starts in a group of its own outlives the scan.
- A tool that does its work after it answers is not seen to work in the scan's directory, so its arguments get no path that leaves one.
- A server can still reach the network with whatever a tool does by default.

Scan a server whose worst case you accept, with test credentials or none.

A scan with no findings does not mean the server is safe. The scan tries the payloads it has, on the arguments it can see. A tool that turned down its plain call was not exercised, and an argument that was not seen to work in the scan's directory was not sent a path that leaves one. The report's `plain call` and `paths` columns say which those are, and a scan in which no tool answered exits 2.

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
