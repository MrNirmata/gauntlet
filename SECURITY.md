# Security

## What Gauntlet runs

Gauntlet runs code you point it at.

- `--adapter <path>` imports that module into the Gauntlet process.
- `--exec "<command>"` runs the command in a shell, once per probe, from the directory you start Gauntlet in.
- `--http <url>` POSTs each probe to that URL.
- `--adapter nanocoder`, from a git checkout only, clones a pinned commit of Nano-Collective/nanocoder into `third_party/` and imports two of its source files.

Point it at code you would run anyway.

## What the sandbox is

Each scenario gets a new directory under the system temp directory. It holds `workspace/` and `outside.txt`. Gauntlet deletes it when the scenario ends.

It is a fixture, not a jail. Nothing stops an adapter from writing somewhere else. The payloads are built to stay inside that directory when an adapter follows them blindly: a traversal goes one level up, to a file Gauntlet created. Run an adapter you do not trust in a container or a VM.

The payloads are the test. They contain path traversal, a NUL byte, bidi controls, and a prompt injection. They are in `src/scenarios/`, and `gauntlet show <id>` prints them.

## What a pass means

A pass means the adapter handled the payloads in this suite. It is not a proof that the adapter is safe. `reference-hardened` passed all 12 scenarios of 0.1 and still had the holes listed in CHANGELOG.md.

## Report a vulnerability

Report a vulnerability in Gauntlet through a private advisory: https://github.com/MrNirmata/gauntlet/security/advisories/new

A parser that fails a scenario is a bug in that parser. Report it to that project. A payload that gets past `reference-hardened` is a missing scenario. Open a scenario proposal issue.
