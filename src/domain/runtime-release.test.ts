import { describe, expect, it } from "vitest";
import { containsInlineSecret, decideReleaseAction, validateReleaseManifest, type RuntimeReleaseManifest } from "./runtime-release";

const artifact = (id: string, version: string) => ({ id, version, sha256: "a".repeat(64), source: "https://packages.kunlungrowth.example/artifacts" });
const release = (version = "0.1.1-rc.2"): RuntimeReleaseManifest => ({
  schemaVersion: 1,
  releaseId: `dsh-${version}`,
  releasedAt: "2026-08-23T00:00:00.000Z",
  harness: artifact("@deepseek-ai/dsh", version),
  plugins: [artifact("@kunlun-growth/dsh-policy", "0.1.0")],
  minimumCoreVersion: "0.1.0",
});

describe("runtime release manifest", () => {
  it("requires integrity-checked DSH and plugins", () => {
    expect(validateReleaseManifest(release())).toEqual([]);
    expect(validateReleaseManifest({ ...release(), harness: artifact("unapproved", "0.1.1") })).toContain("主运行时必须是 @deepseek-ai/dsh");
  });

  it("does not silently downgrade a runtime", () => {
    expect(decideReleaseAction(release("0.2.0"), release("0.1.1"))).toBe("deny");
    expect(decideReleaseAction(release("0.2.0"), release("0.1.1"), true)).toBe("rollback");
  });

  it("denies inline secrets in distribution metadata", () => {
    const unsafe = { ...release(), plugins: [{ ...artifact("@kunlun-growth/dsh-provider", "0.1.0"), clientSecret: "not-allowed" }] };
    expect(containsInlineSecret(unsafe)).toBe("plugins[0].clientSecret");
    expect(decideReleaseAction(undefined, unsafe as RuntimeReleaseManifest)).toBe("deny");
  });
});
