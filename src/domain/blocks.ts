import type { RuntimeEngine } from "./runtime";

export type BlockSlot = "navigation" | "inspector" | "composer" | "runtime";

export interface FeatureBlock {
  id: string;
  name: string;
  description: string;
  slot: BlockSlot;
  icon: string;
  defaultEnabled: boolean;
  required?: boolean;
  engines: RuntimeEngine[];
}

export interface BlockPreference {
  id: string;
  enabled: boolean;
  order: number;
}

export const featureBlocks: FeatureBlock[] = [
  { id: "tasks", name: "任务与历史", description: "创建、恢复、重命名和归档会话", slot: "navigation", icon: "⌘", defaultEnabled: true, required: true, engines: ["codex", "deepseek-harness"] },
  { id: "models", name: "模型与内核", description: "选择模型、推理强度与代理内核", slot: "navigation", icon: "⌁", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "governance", name: "企业策略", description: "审批、沙箱、网络与凭据策略", slot: "navigation", icon: "◈", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "runtime", name: "运行环境", description: "显示内核连接状态与版本", slot: "inspector", icon: "●", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "workspace", name: "工作区", description: "显示并切换当前代码项目", slot: "inspector", icon: "▰", defaultEnabled: true, required: true, engines: ["codex", "deepseek-harness"] },
  { id: "metrics", name: "任务统计", description: "命令、工具与文件变更统计", slot: "inspector", icon: "▦", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "diff", name: "Diff 审阅", description: "查看任务产生的统一代码差异", slot: "inspector", icon: "±", defaultEnabled: true, engines: ["codex"] },
  { id: "capabilities", name: "能力清单", description: "展示当前内核可调用的能力", slot: "inspector", icon: "✓", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "plan", name: "Plan", description: "展示并跟踪代理执行计划", slot: "composer", icon: "☷", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "terminal", name: "集成终端", description: "在任务内展示命令及持续输出", slot: "composer", icon: ">_", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "skills", name: "Skills", description: "为代理安装可复用工作流程", slot: "runtime", icon: "◆", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "mcp", name: "MCP", description: "连接企业工具、服务和数据", slot: "runtime", icon: "⌘", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "subagents", name: "子代理", description: "将独立工作委托给其他代理", slot: "runtime", icon: "◇", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
  { id: "code-mode", name: "Code Mode", description: "让模型用代码组合多个工具调用", slot: "runtime", icon: "{}", defaultEnabled: true, engines: ["codex", "deepseek-harness"] },
];

export function defaultBlockPreferences(): BlockPreference[] {
  return featureBlocks.map((block, order) => ({ id: block.id, enabled: block.required || block.defaultEnabled, order }));
}

export function mergeBlockPreferences(value: unknown): BlockPreference[] {
  const saved = Array.isArray(value) ? value : [];
  const map = new Map(saved.map((entry) => {
    const item = entry && typeof entry === "object" ? entry as Partial<BlockPreference> : {};
    return [item.id, item];
  }));
  return featureBlocks.map((block, fallbackOrder) => {
    const item = map.get(block.id);
    return { id: block.id, enabled: block.required || (typeof item?.enabled === "boolean" ? item.enabled : block.defaultEnabled), order: typeof item?.order === "number" ? item.order : fallbackOrder };
  }).sort((a, b) => a.order - b.order).map((item, order) => ({ ...item, order }));
}

export function visibleBlocks(preferences: BlockPreference[], slot: BlockSlot, engine: RuntimeEngine): FeatureBlock[] {
  const byId = new Map(featureBlocks.map((block) => [block.id, block]));
  return preferences.filter((item) => item.enabled).sort((a, b) => a.order - b.order).map((item) => byId.get(item.id)).filter((block): block is FeatureBlock => Boolean(block && block.slot === slot && block.engines.includes(engine)));
}

export function updateBlockPreference(preferences: BlockPreference[], id: string, update: Partial<Pick<BlockPreference, "enabled" | "order">>): BlockPreference[] {
  const block = featureBlocks.find((item) => item.id === id);
  return preferences.map((item) => item.id === id ? { ...item, ...update, enabled: block?.required ? true : update.enabled ?? item.enabled } : item).sort((a, b) => a.order - b.order).map((item, order) => ({ ...item, order }));
}

export function moveBlock(preferences: BlockPreference[], id: string, direction: -1 | 1): BlockPreference[] {
  const sorted = [...preferences].sort((a, b) => a.order - b.order);
  const block = featureBlocks.find((item) => item.id === id);
  if (!block) return sorted;
  const peers = sorted.filter((item) => featureBlocks.find((candidate) => candidate.id === item.id)?.slot === block.slot);
  const peerIndex = peers.findIndex((item) => item.id === id);
  const targetPeer = peers[peerIndex + direction];
  if (peerIndex < 0 || !targetPeer) return sorted;
  const index = sorted.findIndex((item) => item.id === id);
  const target = sorted.findIndex((item) => item.id === targetPeer.id);
  [sorted[index], sorted[target]] = [sorted[target], sorted[index]];
  return sorted.map((item, order) => ({ ...item, order }));
}
