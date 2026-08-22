import type { ProviderAdapter, ProviderProtocol } from "./enterprise-config";

export type ProviderKind = "account" | "api";

export interface ProviderPreset {
  id: string;
  name: string;
  region: "全球" | "中国" | "企业";
  kind: ProviderKind;
  protocol: ProviderProtocol;
  adapter: ProviderAdapter;
  baseUrl: string;
  suggestedModels: string[];
  note: string;
}

export const providerPresets: ProviderPreset[] = [
  { id: "openai", name: "OpenAI", region: "全球", kind: "account", protocol: "openai", adapter: "codex-responses", baseUrl: "https://api.openai.com/v1", suggestedModels: [], note: "Codex 账号或 Responses API" },
  { id: "anthropic", name: "Anthropic Claude", region: "全球", kind: "account", protocol: "openai-compatible", adapter: "anthropic-messages", baseUrl: "https://api.anthropic.com", suggestedModels: ["claude-sonnet-4-6", "claude-opus-4-6"], note: "原生 Messages API" },
  { id: "deepseek", name: "DeepSeek", region: "中国", kind: "api", protocol: "openai-compatible", adapter: "openai-chat", baseUrl: "https://api.deepseek.com", suggestedModels: ["deepseek-chat", "deepseek-reasoner"], note: "Chat Completions 适配器" },
  { id: "qwen-cn", name: "通义千问 · 北京", region: "中国", kind: "api", protocol: "openai-compatible", adapter: "openai-chat", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", suggestedModels: ["qwen-plus", "qwen-max"], note: "百炼兼容接口" },
  { id: "qwen-intl", name: "通义千问 · 新加坡", region: "全球", kind: "api", protocol: "openai-compatible", adapter: "openai-chat", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", suggestedModels: ["qwen-plus", "qwen-max"], note: "国际站兼容接口" },
  { id: "gemini", name: "Google Gemini", region: "全球", kind: "api", protocol: "openai-compatible", adapter: "openai-chat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", suggestedModels: ["gemini-2.5-flash", "gemini-2.5-pro"], note: "Google 兼容接口" },
  { id: "openrouter", name: "OpenRouter", region: "全球", kind: "api", protocol: "openai-compatible", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", suggestedModels: [], note: "一个密钥访问多家模型" },
  { id: "azure", name: "Azure OpenAI", region: "企业", kind: "api", protocol: "azure-openai", adapter: "codex-responses", baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1", suggestedModels: [], note: "Responses 端点与部署名" },
  { id: "custom", name: "自定义兼容服务", region: "企业", kind: "api", protocol: "openai-compatible", adapter: "codex-responses", baseUrl: "https://", suggestedModels: [], note: "企业网关或本地代理" },
];

export function matchProvider(baseUrl: string) {
  return providerPresets.find((item) => item.id !== "custom" && baseUrl.startsWith(item.baseUrl.replace(/\/$/, ""))) ?? providerPresets.at(-1)!;
}
