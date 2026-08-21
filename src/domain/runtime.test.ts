import { describe, expect, it } from "vitest";
import { mergeTimelineEntry, normalizeRuntimeEvent, timelineFromThreadResponse } from "./runtime";

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

  it("merges streaming deltas into one timeline item", () => {
    const first = normalizeRuntimeEvent({ method: "item/agentMessage/delta", params: { itemId: "a", delta: "你" } })!;
    const second = normalizeRuntimeEvent({ method: "item/agentMessage/delta", params: { itemId: "a", delta: "好" } })!;
    expect(mergeTimelineEntry(mergeTimelineEntry([], first), second)[0].text).toBe("你好");
  });

  it("hydrates persisted thread items", () => {
    const timeline = timelineFromThreadResponse({ result: { thread: { turns: [{ items: [
      { id: "u", type: "userMessage", content: [{ type: "text", text: "修复测试" }] },
      { id: "c", type: "commandExecution", command: "npm test", aggregatedOutput: "ok", status: "completed" },
    ] }] } } });
    expect(timeline).toMatchObject([{ title: "你", text: "修复测试" }, { kind: "command", title: "npm test", text: "ok" }]);
  });
});
