import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Sandbox } from "./types.ts";

export const FIXTURE_NOTE = "hello\n";
// Text nothing writes by accident. A check looks for it in what an adapter
// sent back, a refusal included, and a refusal may well say "secret".
export const FIXTURE_SECRET = "gauntlet-outside-5f2b81c7\n";

export function createSandbox(): Sandbox {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "gauntlet-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const outsideFile = path.join(rootDir, "outside.txt");
  mkdirSync(workspaceDir);
  writeFileSync(path.join(workspaceDir, "notes.txt"), FIXTURE_NOTE);
  writeFileSync(outsideFile, FIXTURE_SECRET);
  return { rootDir, workspaceDir, outsideFile };
}

// An adapter can leave the sandbox in a state rm cannot clear: a directory
// with no permissions, or a process still writing into it. One scenario's
// leftovers must not end the run, so a second failure leaves the directory.
export function deleteSandbox(sandbox: Sandbox): void {
  const remove = (): void => {
    rmSync(sandbox.rootDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  };
  try {
    remove();
  } catch {
    try {
      unlock(sandbox.rootDir);
      remove();
    } catch {
      // Left for the system to clear with the rest of the temp directory.
    }
  }
}

function unlock(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) unlock(path.join(dir, entry.name));
  }
}
