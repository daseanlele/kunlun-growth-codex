export type ApprovalKind = "command" | "file-write" | "network" | "mcp";

export type AgentEvent =
  | { type: "runtime.ready"; version: string }
  | { type: "thread.created"; threadId: string; title?: string }
  | { type: "turn.started"; turnId: string }
  | { type: "message.delta"; turnId: string; text: string }
  | { type: "tool.started"; turnId: string; tool: string; summary: string }
  | { type: "tool.completed"; turnId: string; tool: string; success: boolean }
  | {
      type: "approval.requested";
      approvalId: string;
      kind: ApprovalKind;
      title: string;
      detail: string;
    }
  | { type: "files.changed"; turnId: string; paths: string[] }
  | { type: "command.output"; turnId: string; chunk: string }
  | { type: "turn.completed"; turnId: string; success: boolean }
  | { type: "runtime.error"; code: string; message: string; recoverable: boolean };

export type RuntimeStatus = "stopped" | "starting" | "ready" | "recovering" | "error";

