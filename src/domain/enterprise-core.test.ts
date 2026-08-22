import { describe, expect, it } from "vitest";
import { builtinConnectorCatalog, createInstallPlan, evaluateGovernance, redactAuditValue, type ConnectorManifest, type OrganizationPolicy } from "./enterprise-core";

const policy: OrganizationPolicy = {
  approvedConnectors: ["kunlun.obsidian.local", "kunlun.feishu.open"],
  allowedCapabilities: ["knowledge.read", "knowledge.sync", "business.search"],
  allowedDomains: ["open.feishu.cn"],
  requireApprovalFor: ["knowledge.sync"],
  allowCustomConnectors: false,
  allowRestrictedDataEgress: false,
};

describe("enterprise connector core", () => {
  it("orders requested connectors and reports the credential references required by installation", () => {
    const plan = createInstallPlan(builtinConnectorCatalog, [], []);
    expect(plan.errors).toEqual([]);
    expect(plan.ordered.map((item) => item.id)).toEqual(["kunlun.obsidian.local", "kunlun.feishu.open"]);
    expect(plan.missingSecrets).toEqual(["feishu.app-credential"]);
  });

  it("fails closed when a connector, scope, secret, or destination is not approved", () => {
    const result = evaluateGovernance(policy, { connector: builtinConnectorCatalog[1], capability: "knowledge.read", destination: "untrusted.example", hasRequiredSecrets: true });
    expect(result.decision).toBe("deny");
    expect(result.auditEvent.connectorId).toBe("kunlun.feishu.open");
  });

  it("routes approved sync operations through approval and allows local knowledge reads", () => {
    expect(evaluateGovernance(policy, { connector: builtinConnectorCatalog[1], capability: "knowledge.sync", destination: "open.feishu.cn", hasRequiredSecrets: true }).decision).toBe("approve");
    expect(evaluateGovernance(policy, { connector: builtinConnectorCatalog[0], capability: "knowledge.read", hasRequiredSecrets: true }).decision).toBe("allow");
  });

  it("rejects unapproved custom plugins and redacts secret-like values in audit data", () => {
    const custom: ConnectorManifest = { ...builtinConnectorCatalog[0], id: "customer.unsafe", trust: "custom" };
    expect(evaluateGovernance(policy, { connector: custom, capability: "knowledge.read", hasRequiredSecrets: true }).decision).toBe("deny");
    expect(redactAuditValue("Authorization: Bearer abc123 token=xyz")).toBe("Authorization: Bearer [REDACTED] token=[REDACTED]");
  });
});
