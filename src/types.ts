export type Category =
  | "whitespace"
  | "json"
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
  readonly summary: string;
  readonly aborted: boolean;
  prepare?(sandbox: Sandbox): void;
  readonly probes: readonly ((sandbox: Sandbox) => string)[];
  expect(input: { outputs: readonly RunOutput[]; sandbox: Sandbox }): Check;
};

export type Result = {
  id: string;
  title: string;
  category: Category;
  status: "pass" | "fail" | "error" | "not-covered";
  reason: string;
};
