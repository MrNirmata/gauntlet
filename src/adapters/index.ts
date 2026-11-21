import { nanocoder } from "./nanocoder.ts";
import { adapters as referenceAdapters } from "./reference.ts";

export const adapters = [...referenceAdapters, nanocoder];
