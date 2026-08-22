export type ProviderProtocol = "openai" | "azure-openai" | "openai-compatible";
export type AuthMethod = "api-key" | "oauth" | "managed-token";
export type ProviderAdapter = "codex-responses" | "openai-chat" | "anthropic-messages";

export interface ProviderConfig {
  id: string;
  providerId: string;
  displayName: string;
  protocol: ProviderProtocol;
  adapter: ProviderAdapter;
  baseUrl: string;
  model: string;
  authMethod: AuthMethod;
  credentialRef?: string;
  headers?: Record<string, string>;
}

export interface SecurityConfig {
  shellApproval: "always" | "on-risk" | "never";
  fileWriteScope: "workspace-only" | "ask-outside-workspace";
  networkMode: "disabled" | "allowlist" | "unrestricted";
  allowedDomains: string[];
}

export interface EnterpriseConfig {
  schemaVersion: 1;
  organization: {
    id: string;
    displayName: string;
  };
  provider: ProviderConfig;
  security: SecurityConfig;
  features: {
    mcp: boolean;
    customSkills: boolean;
    telemetry: boolean;
  };
  locks: string[];
}

export const defaultConfig: EnterpriseConfig = {
  schemaVersion: 1,
  organization: {
    id: "local",
    displayName: "本地开发环境",
  },
  provider: {
    id: "default",
    providerId: "openai",
    displayName: "OpenAI",
    protocol: "openai",
    adapter: "codex-responses",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    authMethod: "api-key",
  },
  security: {
    shellApproval: "always",
    fileWriteScope: "workspace-only",
    networkMode: "allowlist",
    allowedDomains: [],
  },
  features: {
    mcp: true,
    customSkills: true,
    telemetry: false,
  },
  locks: [],
};

export type ConfigOverlay = Partial<{
  organization: Partial<EnterpriseConfig["organization"]>;
  provider: Partial<ProviderConfig>;
  security: Partial<SecurityConfig>;
  features: Partial<EnterpriseConfig["features"]>;
}>;

export function mergeConfig(
  base: EnterpriseConfig,
  overlay: ConfigOverlay,
  lockedPaths: string[] = base.locks,
): EnterpriseConfig {
  const isLocked = (path: string) => lockedPaths.includes(path);
  const apply = <T extends object>(section: keyof ConfigOverlay, current: T, next?: Partial<T>): T => {
    if (!next) return current;
    const result = { ...current };
    for (const [key, value] of Object.entries(next)) {
      if (!isLocked(`${String(section)}.${key}`) && value !== undefined) {
        (result as Record<string, unknown>)[key] = value;
      }
    }
    return result;
  };

  return {
    ...base,
    organization: apply("organization", base.organization, overlay.organization),
    provider: apply("provider", base.provider, overlay.provider),
    security: apply("security", base.security, overlay.security),
    features: apply("features", base.features, overlay.features),
  };
}

export function validateConfig(config: EnterpriseConfig): string[] {
  const errors: string[] = [];
  if (config.schemaVersion !== 1) errors.push("仅支持 schemaVersion 1");
  if (!config.organization.id.trim()) errors.push("organization.id 不能为空");
  if (!config.provider.baseUrl.startsWith("https://")) {
    errors.push("生产环境 API 地址必须使用 HTTPS");
  }
  if (config.security.networkMode === "allowlist" && !Array.isArray(config.security.allowedDomains)) {
    errors.push("allowedDomains 必须是数组");
  }
  return errors;
}
