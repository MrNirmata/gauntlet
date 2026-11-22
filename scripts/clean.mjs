// tsc does not delete output for a source file that is gone. A stale file in
// dist would ship in the npm tarball.
import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
