import { http } from '@kit.NetworkKit';
import { AgentReply, GatewayHealth } from '../model/AgentModels';

export class AgentGateway {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private assertSecure(): void {
    if (!this.baseUrl.startsWith('https://')) {
      throw new Error('企业网关必须使用 HTTPS');
    }
  }

  private async request<T>(path: string, method: http.RequestMethod, body?: object): Promise<T> {
    this.assertSecure();
    const client = http.createHttp();
    try {
      const response = await client.request(`${this.baseUrl}${path}`, {
        method,
        header: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        extraData: body ? JSON.stringify(body) : undefined,
        connectTimeout: 10000,
        readTimeout: 60000
      });
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(`网关返回 ${response.responseCode}`);
      }
      return JSON.parse(String(response.result)) as T;
    } finally {
      client.destroy();
    }
  }

  health(): Promise<GatewayHealth> {
    return this.request<GatewayHealth>('/v1/health', http.RequestMethod.GET);
  }

  send(projectId: string, message: string): Promise<AgentReply> {
    return this.request<AgentReply>('/v1/tasks', http.RequestMethod.POST, { projectId, message });
  }
}
