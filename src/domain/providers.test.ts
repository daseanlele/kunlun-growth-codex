import { describe, expect, it } from "vitest";
import { matchProvider, providerPresets } from "./providers";

describe("provider presets", () => {
  it("matches official endpoints", () => {
    expect(matchProvider("https://api.deepseek.com").id).toBe("deepseek");
    expect(matchProvider("https://generativelanguage.googleapis.com/v1beta/openai/").id).toBe("gemini");
  });

  it("keeps every preset on HTTPS", () => {
    expect(providerPresets.every((item) => item.baseUrl.startsWith("https://"))).toBe(true);
  });
});
