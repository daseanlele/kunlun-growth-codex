export type RuntimeEngine = "codex" | "deepseek-harness";
export type TimelineKind = "message" | "reasoning" | "command" | "file" | "tool" | "plan" | "status" | "error";

export interface RuntimeSession {
  id: string;
  engine: RuntimeEngine;
  title: string;
  cwd: string;
  updatedAt: string;
  status: "idle" | "running" | "completed" | "failed";
}

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  text?: string;
  status?: "running" | "completed" | "failed" | "pending";
  paths?: string[];
}

export interface RuntimeCapabilities {
  history: boolean;
  approvals: boolean;
  diff: boolean;
  plan: boolean;
  subagents: boolean;
  codeMode: boolean;
}

export const runtimeCatalog: Record<RuntimeEngine, { label: string; shortLabel: string; capabilities: RuntimeCapabilities }> = {
  codex: {
    label: "Codex App Server",
    shortLabel: "Codex",
    capabilities: { history: true, approvals: true, diff: true, plan: true, subagents: true, codeMode: true },
  },
  "deepseek-harness": {
    label: "DeepSeek Harness",
    shortLabel: "DeepSeek",
    capabilities: { history: true, approvals: true, diff: false, plan: true, subagents: true, codeMode: true },
  },
};

export interface ProtocolEnvelope {
  method?: string;
  params?: Record<string, unknown>;
}

export function normalizeRuntimeEvent(message: ProtocolEnvelope): TimelineEntry | null {
  const method = message.method ?? "";
  const params = message.params ?? {};
  const item = asRecord(params.item);
  const turn = asRecord(params.turn);
  const id = stringValue(item.id) ?? stringValue(turn.id) ?? `${method}-${Date.now()}`;

  if (method.includes("agentMessage") || method.includes("assistant/message")) {
    return { id, kind: "message", title: "助手回复", text: extractText(params), status: "completed" };
  }
  if (method.includes("reasoning") || method.includes("assistant/chunk")) {
    return { id, kind: "reasoning", title: "正在分析", text: extractText(params), status: "running" };
  }
  if (method.includes("command") || item.type === "commandExecution") {
    const command = stringValue(item.command) ?? stringValue(params.command) ?? "命令执行";
    return { id, kind: "command", title: command, text: extractText(params), status: statusOf(item.status) };
  }
  if (method.includes("diff") || item.type === "fileChange") {
    return { id, kind: "file", title: "文件变更", text: stringValue(params.diff), paths: stringArray(params.paths), status: "completed" };
  }
  if (method.includes("plan") || method.includes("todo")) {
    return { id, kind: "plan", title: "任务计划", text: extractText(params), status: "running" };
  }
  if (method.includes("tool") || method.includes("hook")) {
    return { id, kind: "tool", title: stringValue(item.name) ?? method, detail: stringValue(item.description), status: statusOf(item.status) };
  }
  if (method.endsWith("turn/started") || method === "turn/started") {
    return { id, kind: "status", title: "任务已开始", status: "running" };
  }
  if (method.endsWith("turn/completed") || method === "turn/completed" || method === "turn/end") {
    return { id, kind: "status", title: "任务已完成", status: "completed" };
  }
  if (method.includes("error")) {
    return { id, kind: "error", title: "运行错误", text: extractText(params), status: "failed" };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function statusOf(value: unknown): TimelineEntry["status"] {
  if (value === "failed" || value === "error") return "failed";
  if (value === "completed" || value === "success") return "completed";
  return "running";
}

function extractText(params: Record<string, unknown>): string | undefined {
  for (const candidate of [params.delta, params.text, params.message, asRecord(params.item).text, asRecord(params.item).content]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}
