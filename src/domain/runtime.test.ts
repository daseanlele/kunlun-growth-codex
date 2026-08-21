import { describe, expect, it } from "vitest";
import { normalizeRuntimeEvent } from "./runtime";

describe("normalizeRuntimeEvent", () => {
  it("normalizes Codex command items", () => {
    expect(normalizeRuntimeEvent({ method: "item/started", params: { item: { id: "1", type: "commandExecution", command: "npm test" } } }))
      .toMatchObject({ id: "1", kind: "command", title: "npm test", status: "running" });
  });

  it("normalizes DeepSeek turn completion", () => {
    expect(normalizeRuntimeEvent({ method: "turn/end", params: { turn: { id: "turn-1" } } }))
      .toMatchObject({ id: "turn-1", kind: "status", status: "completed" });
  });

  it("ignores unknown protocol noise", () => {
    expect(normalizeRuntimeEvent({ method: "telemetry/ping", params: {} })).toBeNull();
  });
});
