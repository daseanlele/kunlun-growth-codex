export interface AgentMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface GatewayHealth {
  status: string;
  version?: string;
}

export interface AgentReply {
  message: string;
  taskId?: string;
}
