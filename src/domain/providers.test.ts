import { describe, expect, it } from "vitest";
import { matchProvider, providerPresets } from "./providers";

describe("provider presets", () => {
  it("matches official endpoints", () => {
    expect(matchProvider("https://api.deepseek.com").id).toBe("deepseek");
    expect(matchProvider("https://generativelanguage.googleapis.com/v1beta/openai/").id).toBe("gemini");
    expect(matchProvider("https://api.groq.com/openai/v1").id).toBe("groq");
  });

  it("keeps every preset on HTTPS", () => {
    expect(providerPresets.every((item) => item.baseUrl.startsWith("https://"))).toBe(true);
  });

  it("routes each API family through the correct internal adapter", () => {
    expect(providerPresets.find((item) => item.id === "openai")?.adapter).toBe("codex-responses");
    expect(providerPresets.find((item) => item.id === "anthropic")?.adapter).toBe("anthropic-messages");
    expect(providerPresets.find((item) => item.id === "deepseek")?.adapter).toBe("openai-chat");
    expect(providerPresets.find((item) => item.id === "groq")?.adapter).toBe("openai-chat");
  });
});
