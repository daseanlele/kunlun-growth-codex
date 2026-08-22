export type ConnectorKind = "knowledge" | "business" | "model" | "mcp" | "skill" | "workflow";
export type TrustTier = "first-party" | "verified" | "custom";
export type Decision = "allow" | "approve" | "deny";

export interface ConnectorManifest {
  id: string;
  version: string;
  displayName: string;
  kind: ConnectorKind;
  trust: TrustTier;
  capabilities: string[];
  requiredScopes: string[];
  requiredSecrets: string[];
  dependsOn?: string[];
  dataClassification: "internal" | "confidential" | "restricted";
}

export interface OrganizationPolicy {
  approvedConnectors: string[];
  allowedCapabilities: string[];
  allowedDomains: string[];
  requireApprovalFor: string[];
  allowCustomConnectors: boolean;
  allowRestrictedDataEgress: boolean;
}

export interface InstallPlan {
  ordered: ConnectorManifest[];
  missingDependencies: string[];
  missingSecrets: string[];
  errors: string[];
}

export interface GovernanceRequest {
  connector: ConnectorManifest;
  capability: string;
  destination?: string;
  hasRequiredSecrets: boolean;
}

export interface GovernanceResult {
  decision: Decision;
  reason: string;
  auditEvent: {
    type: "connector.access" | "connector.install";
    connectorId: string;
    capability: string;
    decision: Decision;
    destination?: string;
  };
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;

export function validateManifest(manifest: ConnectorManifest): string[] {
  const errors: string[] = [];
  if (!IDENTIFIER.test(manifest.id)) errors.push("连接器 id 只能包含小写字母、数字、点、下划线和连字符");
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(manifest.version)) errors.push("连接器 version 必须为语义化版本");
  if (!manifest.displayName.trim()) errors.push("连接器 displayName 不能为空");
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) errors.push("连接器 capabilities 不能重复");
  if (new Set(manifest.requiredSecrets).size !== manifest.requiredSecrets.length) errors.push("连接器 requiredSecrets 不能重复");
  return errors;
}

export function createInstallPlan(
  requested: ConnectorManifest[],
  installed: ConnectorManifest[],
  availableSecretRefs: string[],
): InstallPlan {
  const requestedById = new Map(requested.map((item) => [item.id, item]));
  const allById = new Map([...installed, ...requested].map((item) => [item.id, item]));
  const errors = requested.flatMap((item) => validateManifest(item).map((error) => `${item.id}: ${error}`));
  const missingDependencies = new Set<string>();
  const missingSecrets = new Set<string>();
  const permanent = new Set<string>();
  const visiting = new Set<string>();
  const ordered: ConnectorManifest[] = [];

  const visit = (id: string) => {
    if (permanent.has(id)) return;
    if (visiting.has(id)) { errors.push(`连接器依赖存在循环：${[...visiting, id].join(" -> ")}`); return; }
    const connector = allById.get(id);
    if (!connector) { missingDependencies.add(id); return; }
    visiting.add(id);
    for (const dependency of connector.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    permanent.add(id);
    if (requestedById.has(id)) ordered.push(connector);
  };

  for (const connector of requested) {
    for (const secret of connector.requiredSecrets) if (!availableSecretRefs.includes(secret)) missingSecrets.add(secret);
    visit(connector.id);
  }
  return { ordered, missingDependencies: [...missingDependencies].sort(), missingSecrets: [...missingSecrets].sort(), errors };
}

export function evaluateGovernance(policy: OrganizationPolicy, request: GovernanceRequest): GovernanceResult {
  const { connector, capability, destination, hasRequiredSecrets } = request;
  const auditEvent = { type: "connector.access" as const, connectorId: connector.id, capability, decision: "deny" as Decision, destination };
  const decision = (value: Decision, reason: string): GovernanceResult => ({ ...{ decision: value, reason }, auditEvent: { ...auditEvent, decision: value } });
  if (connector.trust === "custom" && !policy.allowCustomConnectors) return decision("deny", "组织策略禁止未验证的自定义连接器");
  if (!policy.approvedConnectors.includes(connector.id)) return decision("deny", "连接器尚未获组织批准");
  if (!connector.capabilities.includes(capability) || !policy.allowedCapabilities.includes(capability)) return decision("deny", "请求的能力不在批准范围内");
  if (!hasRequiredSecrets) return decision("deny", "所需凭据尚未由系统凭据库提供");
  if (destination && !policy.allowedDomains.includes(destination)) return decision("deny", "目标域名不在企业白名单内");
  if (destination && connector.dataClassification === "restricted" && !policy.allowRestrictedDataEgress) return decision("deny", "限制级数据禁止发送至外部目标");
  if (policy.requireApprovalFor.includes(capability)) return decision("approve", "此能力需要人工审批");
  return decision("allow", "符合组织策略");
}

export function redactAuditValue(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export const builtinConnectorCatalog: ConnectorManifest[] = [
  {
    id: "kunlun.obsidian.local", version: "0.1.0", displayName: "Obsidian 本地知识库", kind: "knowledge", trust: "first-party",
    capabilities: ["knowledge.read", "knowledge.sync"], requiredScopes: ["filesystem:workspace"], requiredSecrets: [], dataClassification: "internal",
  },
  {
    id: "kunlun.feishu.open", version: "0.1.0", displayName: "飞书开放平台", kind: "business", trust: "first-party",
    capabilities: ["knowledge.read", "knowledge.sync", "business.search"], requiredScopes: ["feishu:tenant-read"], requiredSecrets: ["feishu.app-credential"], dataClassification: "confidential",
  },
];
