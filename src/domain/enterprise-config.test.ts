import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig, validateConfig } from "./enterprise-config";

describe("enterprise config", () => {
  it("allows user overrides for unlocked values", () => {
    const result = mergeConfig(defaultConfig, {
      provider: { model: "company-coding-model" },
    });
    expect(result.provider.model).toBe("company-coding-model");
  });

  it("preserves locked enterprise values", () => {
    const managed = {
      ...defaultConfig,
      provider: { ...defaultConfig.provider, baseUrl: "https://ai.example.com/v1" },
      locks: ["provider.baseUrl"],
    };
    const result = mergeConfig(managed, {
      provider: { baseUrl: "https://untrusted.example/v1" },
    });
    expect(result.provider.baseUrl).toBe("https://ai.example.com/v1");
  });

  it("rejects insecure production endpoints", () => {
    const config = {
      ...defaultConfig,
      provider: { ...defaultConfig.provider, baseUrl: "http://ai.example.com/v1" },
    };
    expect(validateConfig(config)).toContain("生产环境 API 地址必须使用 HTTPS");
  });
});

