export type HerdrCall = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export type AgentSessionInfo = {
  agent: string;
  kind: "id" | "path";
  value: string;
};

export type SessionFile = {
  path: string;
  mtimeMs: number;
  size?: number;
  identity?: string;
  changeToken?: string;
  sessionId?: string;
};
