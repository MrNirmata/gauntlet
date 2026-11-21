import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanocoder } from "./nanocoder.ts";
import { adapters as referenceAdapters } from "./reference.ts";

// The worker is a TypeScript source file run with tsx. It is not in the npm
// tarball. Register nanocoder only when that file is on disk.
function nanocoderWorkerPresent(): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "nanocoder-worker.ts"),
    path.join(here, "../../src/adapters/nanocoder-worker.ts"),
  ];
  return candidates.some((file) => existsSync(file));
}

export const adapters = nanocoderWorkerPresent()
  ? [...referenceAdapters, nanocoder]
  : referenceAdapters;
