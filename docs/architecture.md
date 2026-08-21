# 架构

昆仑增长采用“可信桌面执行核心 + 企业网关 + 多端入口”的结构。Windows/macOS 可以直接访问用户选择的本地工作区；HarmonyOS 不直接接触桌面文件系统，而是通过 HTTPS 连接企业 Agent Gateway。

```text
Windows / macOS React WebView
           │ typed Tauri IPC
           ▼
Rust desktop core ── Runtime Adapter ─┬─ Codex App Server
  │ policy / vault / approvals        └─ DeepSeek Harness ACP
  └──────────── HTTPS approved providers ───────────────┘

HarmonyOS ArkTS ── HTTPS + enterprise auth ── Agent Gateway
                                                 │
                                      managed desktop/runner
```

## 信任边界

1. WebView 不承担策略执行或秘密存储。
2. Rust 接口保持窄类型，Codex 以直接子进程启动，不经过 shell 插值。
3. 项目内容是不可信输入，不能覆盖托管策略。
4. API Key 存在系统安全凭据库，诊断信息必须脱敏。
5. 企业网关负责身份、设备、项目授权和审计；移动端不保存长期令牌。

## App Server 生命周期

桌面核心依次调用 `initialize`、`initialized`、`thread/start` 与 `turn/start`。上游请求和通知通过 Tauri 事件转发；命令执行与文件变更请求必须由用户或托管策略明确决策。

DeepSeek Harness 通过独立的 ACP JSON-RPC stdio 适配器接入，使用 `session/new` 与 `session/prompt`。每个会话固定一个运行时内核；两套协议在进入界面前归一化为昆仑增长的 Timeline 事件，禁止共享进程状态或直接混写会话日志。

## 配置优先级

```text
产品默认值 < 项目偏好 < 用户偏好 < 已签名企业托管值
```

锁定字段不允许低优先级配置覆盖。当前预览版已实现本地 Provider 与安全凭据；签名托管配置和完整策略引擎列入后续里程碑。

## 发布

- Windows：NSIS `.exe` 与 MSI；
- macOS：通用 `.app` / DMG，正式发行需 Developer ID 签名和公证；
- HarmonyOS：HAP/APP，需 DevEco Studio、企业签名证书与应用市场流程。
