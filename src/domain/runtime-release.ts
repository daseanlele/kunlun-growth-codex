export interface LockedArtifact {
  id: string;
  version: string;
  sha256: string;
  source: string;
}

export interface RuntimeReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  releasedAt: string;
  harness: LockedArtifact;
  plugins: LockedArtifact[];
  minimumCoreVersion: string;
}

export type ReleaseAction = "install" | "upgrade" | "rollback" | "keep" | "deny";

const SHA256 = /^[a-f0-9]{64}$/i;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

export function validateReleaseManifest(manifest: RuntimeReleaseManifest): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) errors.push("不支持的发行清单版本");
  if (!manifest.releaseId.trim()) errors.push("releaseId 不能为空");
  if (Number.isNaN(Date.parse(manifest.releasedAt))) errors.push("releasedAt 必须是有效时间");
  const artifacts = [manifest.harness, ...manifest.plugins];
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact.id.trim()) errors.push("发行工件 id 不能为空");
    if (ids.has(artifact.id)) errors.push(`发行工件重复：${artifact.id}`);
    ids.add(artifact.id);
    if (!SEMVER.test(artifact.version)) errors.push(`${artifact.id} 版本不是语义化版本`);
    if (!SHA256.test(artifact.sha256)) errors.push(`${artifact.id} 缺少 SHA-256 完整性校验`);
    if (!artifact.source.startsWith("https://")) errors.push(`${artifact.id} 来源必须使用 HTTPS`);
  }
  if (manifest.harness.id !== "@deepseek-ai/dsh") errors.push("主运行时必须是 @deepseek-ai/dsh");
  return errors;
}

export function containsInlineSecret(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = containsInlineSecret(value[index], `${path}[${index}]`);
      if (result) return result;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)/i.test(key) && typeof child === "string" && child.length > 0) {
      return childPath;
    }
    const result = containsInlineSecret(child, childPath);
    if (result) return result;
  }
  return null;
}

export function decideReleaseAction(current: RuntimeReleaseManifest | undefined, next: RuntimeReleaseManifest, explicitlyRollback = false): ReleaseAction {
  if (validateReleaseManifest(next).length || containsInlineSecret(next)) return "deny";
  if (!current) return "install";
  if (current.releaseId === next.releaseId) return "keep";
  const comparison = compareSemver(next.harness.version, current.harness.version);
  if (comparison < 0) return explicitlyRollback ? "rollback" : "deny";
  return "upgrade";
}

export function compareSemver(left: string, right: string): number {
  const leftMatch = left.match(SEMVER); const rightMatch = right.match(SEMVER);
  if (!leftMatch || !rightMatch) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference) return Math.sign(difference);
  }
  return left.localeCompare(right);
}
