import type { ProviderProtocol } from "./enterprise-config";

export type ProviderKind = "account" | "api";

export interface ProviderPreset {
  id: string;
  name: string;
  region: "全球" | "中国" | "企业";
  kind: ProviderKind;
  protocol: ProviderProtocol;
  baseUrl: string;
  suggestedModels: string[];
  note: string;
}

export const providerPresets: ProviderPreset[] = [
  { id: "openai", name: "OpenAI", region: "全球", kind: "account", protocol: "openai", baseUrl: "https://api.openai.com/v1", suggestedModels: [], note: "支持 Codex 账号登录或 API Key" },
  { id: "anthropic", name: "Anthropic Claude", region: "全球", kind: "account", protocol: "openai-compatible", baseUrl: "https://api.anthropic.com", suggestedModels: [], note: "由 Claude 原生适配器处理 Messages API" },
  { id: "deepseek", name: "DeepSeek", region: "中国", kind: "api", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", suggestedModels: ["deepseek-chat", "deepseek-reasoner"], note: "OpenAI 兼容接口" },
  { id: "qwen-cn", name: "通义千问 · 北京", region: "中国", kind: "api", protocol: "openai-compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", suggestedModels: ["qwen-plus", "qwen-max"], note: "阿里云百炼 OpenAI 兼容接口" },
  { id: "qwen-intl", name: "通义千问 · 新加坡", region: "全球", kind: "api", protocol: "openai-compatible", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", suggestedModels: ["qwen-plus", "qwen-max"], note: "国际站 OpenAI 兼容接口" },
  { id: "gemini", name: "Google Gemini", region: "全球", kind: "api", protocol: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", suggestedModels: ["gemini-3.7-flash", "gemini-3.1-pro"], note: "Google 官方 OpenAI 兼容接口" },
  { id: "openrouter", name: "OpenRouter", region: "全球", kind: "api", protocol: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", suggestedModels: [], note: "一个密钥访问多家模型" },
  { id: "azure", name: "Azure OpenAI", region: "企业", kind: "api", protocol: "azure-openai", baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1", suggestedModels: [], note: "填写企业资源地址与部署名" },
  { id: "custom", name: "自定义兼容服务", region: "企业", kind: "api", protocol: "openai-compatible", baseUrl: "https://", suggestedModels: [], note: "适用于企业网关、本地代理和模型聚合服务" },
];

export function matchProvider(baseUrl: string) {
  return providerPresets.find((item) => item.id !== "custom" && baseUrl.startsWith(item.baseUrl.replace(/\/$/, ""))) ?? providerPresets.at(-1)!;
}
