import { describe, expect, it } from "vitest";
import { defaultBlockPreferences, mergeBlockPreferences, moveBlock, visibleBlocks } from "./blocks";

describe("feature blocks", () => {
  it("keeps required blocks enabled", () => {
    const merged = mergeBlockPreferences([{ id: "workspace", enabled: false, order: 0 }]);
    expect(merged.find((item) => item.id === "workspace")?.enabled).toBe(true);
  });

  it("filters engine-specific blocks", () => {
    expect(visibleBlocks(defaultBlockPreferences(), "inspector", "deepseek-harness").some((item) => item.id === "diff")).toBe(false);
  });

  it("moves blocks deterministically", () => {
    const preferences = defaultBlockPreferences();
    const moved = moveBlock(preferences, "governance", -1);
    expect(moved.find((item) => item.id === "governance")!.order).toBeLessThan(moved.find((item) => item.id === "models")!.order);
    expect(moved.find((item) => item.id === "tasks")!.order).toBe(0);
  });
});
