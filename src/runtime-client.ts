import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RuntimeStatus } from "./domain/agent-events";
import type { ProviderProtocol } from "./domain/enterprise-config";
import type { AgentModel, RuntimeEngine, RuntimeSession } from "./domain/runtime";

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  pid: number | null;
  binary: string;
  engine: RuntimeEngine;
  available?: boolean;
  version?: string | null;
  lastError: string | null;
}

export interface ProviderConfigPayload {
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  authMethod: string;
  credentialRef: string | null;
}

export interface AppServerMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface WorkspaceEntry { path: string; name: string; isDir: boolean; size: number }
export interface TerminalOutputEvent { id: string; stream: "stdout" | "stderr"; chunk: string }
export interface TerminalExitEvent { id: string; code: number | null }

const webFallback: RuntimeSnapshot = {
  status: "stopped",
  pid: null,
  binary: "codex",
  engine: "codex",
  available: true,
  lastError: null,
};

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function getRuntimeStatus(): Promise<RuntimeSnapshot> {
  if (!isTauri()) return webFallback;
  return invoke<RuntimeSnapshot>("runtime_status");
}

export async function startRuntime(engine: RuntimeEngine = "codex"): Promise<RuntimeSnapshot> {
  if (!isTauri()) return { ...webFallback, engine, binary: engine === "codex" ? "codex" : "dsh", status: "ready" };
  return invoke<RuntimeSnapshot>("start_runtime", { engine });
}

export async function stopRuntime(): Promise<RuntimeSnapshot> {
  if (!isTauri()) return webFallback;
  return invoke<RuntimeSnapshot>("stop_runtime");
}

export async function loadProviderConfig(): Promise<ProviderConfigPayload> {
  if (!isTauri()) return { ...defaultProvider };
  return invoke<ProviderConfigPayload>("load_provider_config");
}

export async function saveProviderConfig(config: ProviderConfigPayload, apiKey: string): Promise<ProviderConfigPayload> {
  if (!isTauri()) return config;
  return invoke<ProviderConfigPayload>("save_provider_config", { config, apiKey: apiKey || null });
}

export async function createAgentThread(cwd: string, model?: string, engine: RuntimeEngine = "codex"): Promise<AppServerMessage> {
  if (!isTauri()) return { result: { thread: { id: "web-preview-thread" } } };
  return invoke<AppServerMessage>("create_thread", { cwd, model: model || null, engine });
}

export async function startAgentTurn(threadId: string, cwd: string, text: string, model?: string, effort?: string): Promise<AppServerMessage> {
  if (!isTauri()) return { result: { turn: { id: "web-preview-turn" } } };
  return invoke<AppServerMessage>("start_turn", { threadId, cwd, text, model: model || null, effort: effort || null });
}

export async function listAgentThreads(engine: RuntimeEngine = "codex"): Promise<RuntimeSession[]> {
  if (!isTauri()) return [];
  const response = await invoke<AppServerMessage>("list_threads", { engine });
  const source = (response.result ?? response) as Record<string, unknown>;
  const rows = (source.data ?? source.threads) as Array<Record<string, unknown>> | undefined;
  return (rows ?? []).map((thread) => ({
    id: String(thread.id ?? ""),
    engine,
    title: String(thread.name ?? thread.title ?? "未命名任务"),
    cwd: String(thread.cwd ?? ""),
    updatedAt: String(thread.updatedAt ?? thread.updated_at ?? new Date().toISOString()),
    status: "idle" as const,
  })).filter((thread) => thread.id.length > 0);
}

export async function readAgentThread(threadId: string): Promise<AppServerMessage> {
  if (!isTauri()) return { result: { thread: { id: threadId, turns: [] } } };
  return invoke<AppServerMessage>("read_thread", { threadId });
}

export async function resumeAgentThread(threadId: string, cwd?: string, model?: string): Promise<AppServerMessage> {
  if (!isTauri()) return { result: { thread: { id: threadId } } };
  return invoke<AppServerMessage>("resume_thread", { threadId, cwd: cwd || null, model: model || null });
}

export async function listAgentModels(): Promise<AgentModel[]> {
  if (!isTauri()) return [
    { id: "gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", description: "平衡能力与成本", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) },
    { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "复杂任务旗舰模型", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) },
  ];
  const response = await invoke<AppServerMessage>("list_models");
  const source = (response.result ?? response) as Record<string, unknown>;
  return Array.isArray(source.data) ? source.data as unknown as AgentModel[] : [];
}

export async function renameAgentThread(threadId: string, name: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_thread_name", { threadId, name });
}

export async function archiveAgentThread(threadId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("archive_thread", { threadId });
}

export async function interruptAgentTurn(threadId: string, turnId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("interrupt_turn", { threadId, turnId });
}

export async function respondToApproval(id: string | number, decision: "accept" | "decline"): Promise<void> {
  if (!isTauri()) return;
  await invoke("respond_server_request", { id, result: { decision } });
}

export async function listWorkspaceFiles(cwd: string): Promise<WorkspaceEntry[]> {
  if (!isTauri()) return [
    { path: "src/App.tsx", name: "App.tsx", isDir: false, size: 18420 },
    { path: "src/runtime-client.ts", name: "runtime-client.ts", isDir: false, size: 7200 },
    { path: "src/domain", name: "domain", isDir: true, size: 0 },
    { path: "src/domain/runtime.ts", name: "runtime.ts", isDir: false, size: 9300 },
    { path: "README.md", name: "README.md", isDir: false, size: 4100 },
  ];
  return invoke<WorkspaceEntry[]>("list_workspace_files", { cwd });
}

export async function readWorkspaceFile(cwd: string, path: string): Promise<string> {
  if (!isTauri()) return `// ${path}\n// 桌面版将在这里显示工作区中的真实文件内容。`;
  return invoke<string>("read_workspace_file", { cwd, path });
}

export async function readGitDiff(cwd: string): Promise<string> {
  if (!isTauri()) return "diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,3 +1,4 @@\n+// 昆仑增长 Diff 审阅预览\n";
  return invoke<string>("read_git_diff", { cwd });
}

export async function runTerminalCommand(cwd: string, command: string): Promise<string> {
  if (!isTauri()) return `web-terminal-${Date.now()}`;
  return invoke<string>("run_terminal_command", { cwd, command });
}

export async function stopTerminalCommand(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("stop_terminal_command", { id });
}

export async function onTerminalOutput(handler: (event: TerminalOutputEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<TerminalOutputEvent>("terminal-output", (event) => handler(event.payload));
}

export async function onTerminalExit(handler: (event: TerminalExitEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<TerminalExitEvent>("terminal-exit", (event) => handler(event.payload));
}

export async function listRuntimeSkills(cwd: string): Promise<AppServerMessage> {
  if (!isTauri()) return { result: { data: [{ cwd, skills: [{ name: "skill-creator", description: "创建和维护可复用工作流", enabled: true }] }] } };
  return invoke<AppServerMessage>("list_skills", { cwd });
}

export async function listMcpServers(threadId?: string): Promise<AppServerMessage> {
  if (!isTauri()) return { result: { data: [] } };
  return invoke<AppServerMessage>("list_mcp_servers", { threadId: threadId || null });
}

export async function onAppServerNotification(handler: (message: AppServerMessage) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<AppServerMessage>("app-server-notification", (event) => handler(event.payload));
}

export async function onAppServerRequest(handler: (message: AppServerMessage) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<AppServerMessage>("app-server-request", (event) => handler(event.payload));
}

const defaultProvider: ProviderConfigPayload = {
  protocol: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  authMethod: "api-key",
  credentialRef: null,
};
