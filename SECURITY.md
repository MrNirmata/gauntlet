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

- With no flag, only a tool the server marks read-only, or one whose name says it only looks. A name is read word by word. The first word has to be one that looks: `get`, `list`, `read`, `search`, and the like. No later word may be `and`, `then`, or `or`, a word that removes or sends, even run together with what it acts on as in `get_deleteall`, a word that writes such as `add`, `set`, or `update`, or a word with a letter outside a to z. So `get_user` and `list_orders` are called, and `get_post`, `list_add`, `status_reset`, and `check_out` wait for `--write`.
- With `--write`, also a tool that nothing marks or names either way.
- With `--destructive`, or when named with `--tool`, also a tool the server marks destructive, one it marks not read-only without saying it is not destructive, one whose name says it removes, sends, or spends, and one that requires an argument named `confirm` or `force`, at the top of its schema, through a `$ref`, or one object down.
- A mark that is not `true` or `false` is read the careful way: `"true"` or `1` for destructive counts as yes, and anything but `true` for read-only counts as no.
- A tool whose schema is deeper or wider than the scan fills in is not called unless it is marked read-only. A call made from it would leave a required part out.
- The names of `--tool`, `--skip`, and `--ignore` are checked against the server's list before the first call.

What it sends:

- Every string the scan makes up, a path or not, names something the scan made: it has `gauntlet-` and the scan's eight random characters in it, or it goes through the scan's own temp directory. It makes up no `..` alone, no empty string, no `/`, no `~`, and no path of yours. The value that is 10000 arrays deep has a word at its centre, so a server that flattens it does not get an empty name. A value the schema fixes with `const` or `enum` is sent as the schema gives it, whatever it is.
- A list is never empty, and a map with no fixed keys gets one key the scan named. A date is 1970-01-02, or 9999-12-31 for an argument named `since`, `after`, or `from`.
- A wrong type is a number where a free string or a list goes, and a word where a number goes. It is never a string where a list goes, which a tool might walk letter by letter, and nothing is put in place of an object.
- A required argument is left out only of a tool the server marks read-only.
- A path that leaves a directory is sent only to an argument seen to work in the scan's own directory: the reply held what only the file it named holds, or what it named changed or appeared. A file the server made for itself under another name does not count.
- A switch is set to what its name says does less, and an option to the value whose name says so. An optional switch or option is not added, and a switch written as a string gets `true` or `false` and no payload. The calls that break the schema leave switches and options as they were, whatever type the schema gives them.
- The commands it tries to inject only `touch` a file in its temp directory, and the path of that directory has no space or shell character in it. If the system temp directory has one, `/tmp` is used, and if that has one too the scan stops.

What it does with its own files:

- The server's directory is four levels inside the temp directory the scan made. No payload goes further than one level above it.
- A call can replace one of the scan's directories with a symlink to somewhere else. Before the scan lists, writes, or removes anything, it checks from the top down that each directory is a real one, and removes a link that is in its place. Just before it removes or writes a file, it checks again that the file's directory is where its name says. It reads only plain files it could have written, not a link, a pipe, or a device, and it replaces a planted file by removing it and making a new one, never by writing into what is there.
- When removing its temp directory fails because a call left a read-only directory, it makes the directories writable and tries again. It opens each without following a link and checks that it is inside the temp directory before changing it.
- The server is started with `PATH`, `LANG`, a temp `HOME`, a temp `TMPDIR`, and no other variable of yours. A variable you pass with `--env` is one the server can use on anything.

What it does not limit:

- The server is your code, running as you, with your files and your network. The environment is trimmed. Nothing else is confined.
- A tool that does harm under a name that says it reads, or that the server wrongly marks read-only, is called with no flag at all.
- With `--write`, a tool that writes is asked to write. A tool that imports, merges, or appends does that to whatever store it has. Which value of an option does least is read from names, and a name can mislead: an option the scan takes for harmless may not be.
- A tool can use one argument in two places. One that makes a copy where it runs, named after its argument, and also acts on the same name in a directory of yours, is taken to work in the scan's directory. What it is then sent still names only what the scan made, so it removes nothing of yours, but it can leave files there.
- A server that keeps its data in a fixed place gets calls there, and they leave files and directories in that place. Their names start with `gauntlet-` and the scan's eight characters, or are `987654321`, and some have control characters, quotes, or a shell command after that. A server that makes directories for a path it is given can leave a tree of them, starting with the first part of the temp directory's path.
- The checks on the scan's own directories are a check and then an act. They hold for whatever a call left behind. A server that keeps a process swapping those directories for links while the scan works can still get between the two, and have the scan remove or write a file through a link. A review did it in one run of three. Such a server can do the same harm itself.
- A tool that renames the scan's temp directory leaves it where it put it, and the scan does not find it again.
- A tool that takes an id, a row, a line, or a key by number is given `987654321`, or the largest number its schema allows. If that exists, the call acts on it. A limit is 1000, an offset is 0, and any other number is 1.
- A payload that tries to run a command has the word `touch` in it. A tool that splits its argument on spaces and acts on each part gets that word as a name.
- A wrong type is still sent. What a tool does with a number where a string goes is the tool's.
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
