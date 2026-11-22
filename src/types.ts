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
};

export type Adapter = {
  readonly name: string;
  run(input: AdapterRunInput): Promise<RunOutput>;
};

export type Sandbox = {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly outsideFile: string;
};

export type Check = { ok: boolean; reason: string };

export type Scenario = {
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
  // Filled in by the runner. A Result built by hand may leave it out.
  probes?: readonly ProbeRecord[];
};

export type RunOptions = {
  // Limit for one adapter.run call. Omit it for no limit.
  timeoutMs?: number;
};
