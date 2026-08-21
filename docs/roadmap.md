# 昆仑增长路线图

## 0.1 开发者预览

- [x] 品牌、跨平台桌面 UI 与 Tauri 核心
- [x] Codex App Server 初始化、线程、任务、事件与审批通道
- [x] Provider/API Key 配置和系统安全凭据库
- [x] Windows/macOS 构建脚本与 CI
- [x] HarmonyOS ArkTS Stage 模型客户端骨架
- [x] 企业配置 Schema 与单元测试
- [ ] Windows 签名、macOS 签名/公证、HarmonyOS 企业签名

## 0.2 企业试点

- Diff 审阅、命令输出和任务恢复体验；
- OIDC Authorization Code + PKCE 与短期令牌代理；
- 签名托管配置、模型/域名白名单、Skills/MCP 校验分发；
- Agent Gateway 参考实现与 HarmonyOS 推送通知；
- 红队、恶意仓库、提示注入和升级回滚测试。

## 1.0

- 三端签名发布与自动更新；
- 管理员控制台、设备策略和可选本地审计；
- 可访问性、国际化、支持包与企业部署手册；
- 至少两个真实企业试点完成验收。

“源码可构建”不等于“可进入生产”。企业正式分发前必须完成证书、隐私政策、合规评估、网关部署和安全测试。
