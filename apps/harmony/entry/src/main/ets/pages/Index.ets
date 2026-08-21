import { AgentGateway } from '../service/AgentGateway';
import { AgentMessage } from '../model/AgentModels';

@Entry
@Component
struct Index {
  @State gatewayUrl: string = '';
  @State token: string = '';
  @State projectId: string = '';
  @State prompt: string = '';
  @State connected: boolean = false;
  @State busy: boolean = false;
  @State notice: string = '配置企业网关后开始使用';
  @State messages: AgentMessage[] = [];

  private async connect(): Promise<void> {
    this.busy = true;
    try {
      const health = await new AgentGateway(this.gatewayUrl, this.token).health();
      this.connected = health.status === 'ok';
      this.notice = this.connected ? `已连接${health.version ? ` · ${health.version}` : ''}` : '网关状态异常';
    } catch (error) {
      this.connected = false;
      this.notice = String(error);
    } finally {
      this.busy = false;
    }
  }

  private async send(): Promise<void> {
    const text = this.prompt.trim();
    if (!text || !this.connected || !this.projectId.trim()) return;
    this.messages.push({ role: 'user', text });
    this.prompt = '';
    this.busy = true;
    try {
      const reply = await new AgentGateway(this.gatewayUrl, this.token).send(this.projectId.trim(), text);
      this.messages.push({ role: 'assistant', text: reply.message });
    } catch (error) {
      this.messages.push({ role: 'assistant', text: `请求失败：${String(error)}` });
    } finally {
      this.busy = false;
    }
  }

  build() {
    Navigation() {
      Column({ space: 16 }) {
        Row({ space: 12 }) {
          Text('昆').fontSize(22).fontWeight(FontWeight.Bold).fontColor(Color.White)
            .width(44).height(44).textAlign(TextAlign.Center).backgroundColor('#6D5DFB').borderRadius(12)
          Column() {
            Text('昆仑增长').fontSize(24).fontWeight(FontWeight.Bold)
            Text('企业 AI 工作台').fontSize(13).fontColor('#7A8194')
          }.alignItems(HorizontalAlign.Start)
        }.width('100%')

        if (!this.connected) {
          Column({ space: 12 }) {
            Text('连接企业网关').fontSize(20).fontWeight(FontWeight.Medium).width('100%')
            TextInput({ placeholder: 'https://ai.example.com', text: this.gatewayUrl })
              .onChange((value: string) => this.gatewayUrl = value)
            TextInput({ placeholder: '访问令牌（仅本次会话）', text: this.token }).type(InputType.Password)
              .onChange((value: string) => this.token = value)
            Button(this.busy ? '连接中…' : '安全连接').enabled(!this.busy).width('100%').onClick(() => this.connect())
          }.padding(20).backgroundColor('#F5F6FA').borderRadius(18).width('100%')
        } else {
          TextInput({ placeholder: '企业项目 ID', text: this.projectId }).onChange((value: string) => this.projectId = value)
          List({ space: 10 }) {
            ForEach(this.messages, (message: AgentMessage) => {
              ListItem() {
                Text(message.text).fontSize(15).fontColor(message.role === 'user' ? Color.White : '#202432')
                  .padding(14).backgroundColor(message.role === 'user' ? '#6D5DFB' : '#F0F2F7').borderRadius(14)
              }
            })
          }.layoutWeight(1).width('100%')
          Row({ space: 8 }) {
            TextInput({ placeholder: '描述你要完成的任务', text: this.prompt }).layoutWeight(1)
              .onChange((value: string) => this.prompt = value)
            Button('发送').enabled(!this.busy).onClick(() => this.send())
          }.width('100%')
        }

        Text(this.notice).fontSize(12).fontColor(this.connected ? '#198754' : '#7A8194').width('100%')
      }.padding(24).width('100%').height('100%').backgroundColor('#FFFFFF')
    }.title('')
  }
}
