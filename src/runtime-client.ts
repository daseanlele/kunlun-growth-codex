import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RuntimeStatus } from "./domain/agent-events";
import type { ProviderProtocol } from "./domain/enterprise-config";

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  pid: number | null;
  binary: string;
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

const webFallback: RuntimeSnapshot = {
  status: "stopped",
  pid: null,
  binary: "codex",
  lastError: null,
};

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function getRuntimeStatus(): Promise<RuntimeSnapshot> {
  if (!isTauri()) return webFallback;
  return invoke<RuntimeSnapshot>("runtime_status");
}

export async function startRuntime(): Promise<RuntimeSnapshot> {
  if (!isTauri()) return { ...webFallback, status: "ready" };
  return invoke<RuntimeSnapshot>("start_runtime");
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

export async function createAgentThread(cwd: string, model?: string): Promise<AppServerMessage> {
  if (!isTauri()) return { result: { thread: { id: "web-preview-thread" } } };
  return invoke<AppServerMessage>("create_thread", { cwd, model: model || null });
}

export async function startAgentTurn(threadId: string, cwd: string, text: string, model?: string): Promise<AppServerMessage> {
  if (!isTauri()) return { result: { turn: { id: "web-preview-turn" } } };
  return invoke<AppServerMessage>("start_turn", { threadId, cwd, text, model: model || null });
}

export async function respondToApproval(id: string | number, decision: "accept" | "decline"): Promise<void> {
  if (!isTauri()) return;
  await invoke("respond_server_request", { id, result: { decision } });
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
