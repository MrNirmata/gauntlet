export type Category =
  | "whitespace"
  | "json"
  | "xml"
  | "unicode"
  | "path"
  | "stream"
  | "injection"
  | "size";

export type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type RunOutput =
  | { status: "executed"; call: ToolCall; result: string }
  | { status: "refused"; reason: string }
  | { status: "not-covered"; reason: string };

export type AdapterRunInput = {
  raw: string;
  sandboxDir: string;
  aborted: boolean;
  // Present in a structured run: the call already split from the raw text.
  // An adapter whose input is a parsed call reads this and not raw.
  call?: ToolCall;
};

export type Adapter = {
  readonly name: string;
  run(input: AdapterRunInput): Promise<RunOutput>;
  // Called after each scenario, before its sandbox is deleted. An adapter
  // that keeps a process alive between probes stops it here.
  close?(): Promise<void>;
};

// safety: the adapter did something it must never do, or took input it
// should have turned down.
// robustness: the adapter turned down, damaged, or crashed on input a model
// really sends.
export type Tier = "safety" | "robustness";

// parse: the payload is raw model text, and the failure is in reading it.
// execute: the payload is a well-formed call, and the failure is in running
// it. A target that receives parsed calls can only be given these.
export type Layer = "parse" | "execute";

export type Classification = {
  readonly tier: Tier;
  readonly layer: Layer;
  // CWE ids for the weakness the scenario looks for, such as "CWE-22".
  readonly cwe: readonly string[];
};

export type Sandbox = {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly outsideFile: string;
};

export type Check = { ok: boolean; reason: string };

export type ScenarioCase = {
  readonly id: string;
  readonly title: string;
  readonly category: Category;
  // One line that names the failure.
  readonly summary: string;
  // One line that says what a correct adapter does.
  readonly expected: string;
  // One line that says what prepare adds to the sandbox.
  readonly setup?: string;
  readonly aborted: boolean;
  prepare?(sandbox: Sandbox): void;
  readonly probes: readonly ((sandbox: Sandbox) => string)[];
  expect(input: { outputs: readonly RunOutput[]; sandbox: Sandbox }): Check;
};

export type Scenario = ScenarioCase & Classification;

export type Status = "pass" | "fail" | "error" | "not-covered";

// What one probe sent and what came back. An adapter that threw, timed out,
// or returned something that is not a RunOutput is recorded as an error.
export type ProbeRecord = {
  raw: string;
  outcome: RunOutput | { status: "error"; reason: string };
};

export type Result = {
  id: string;
  title: string;
  category: Category;
  status: Status;
  reason: string;
  // Filled in by the runner. A Result built by hand may leave these out.
  tier?: Tier;
  probes?: readonly ProbeRecord[];
};

export type RunOptions = {
  // Limit for one adapter.run call. Omit it for no limit.
  timeoutMs?: number;
  // Hand each probe to the adapter as a parsed call. A scenario whose
  // payload is raw model text is not covered in such a run.
  structured?: boolean;
};
