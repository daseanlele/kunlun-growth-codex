# 昆仑增长

面向企业 AI 落地的开源 Codex 工作台：一键安装，自主配置 API、模型和认证，并把命令审批、工作区隔离与企业策略放在本地可信边界中。

> 当前版本：`0.1.0` 开发者预览。Windows/macOS 共用 Tauri 桌面核心；HarmonyOS 提供连接企业 Agent Gateway 的原生 ArkTS 伴生端。

## 已实现

- React 19 + TypeScript 桌面界面与项目选择器；
- 官方 Codex App Server 的 stdio JSON-RPC 初始化、线程、任务与流式事件通道；
- 命令/文件操作审批响应；
- OpenAI、Azure OpenAI 与 OpenAI-compatible Provider 配置；
- API Key 写入 macOS Keychain / Windows Credential Manager，不写入 JSON；
- Windows NSIS/MSI 与 macOS应用打包基础；
- HarmonyOS ArkTS Stage 模型客户端（phone/tablet/2in1）；
- 版本化企业配置 Schema、锁定字段合并测试与跨平台 CI。

## 本地开发

要求 Node.js 22+、Rust stable。Windows 还需要 Visual Studio Build Tools（Desktop development with C++）；macOS 需要 Xcode Command Line Tools。

```bash
npm install
npm test
npm run build
npm run harmony:check
npm run protocol:generate
```

桌面端：

```bash
npm run windows:dev
npm run windows:build
npm run mac:dev
npm run mac:build
```

构建脚本会从固定版本的 `@openai/codex` npm 包准备当前平台运行时；二进制不会提交到 Git。HarmonyOS 的完整 HAP 编译需在 DevEco Studio 中打开 [`apps/harmony`](apps/harmony)。

## 安全模型

- React 不直接启动 shell，Rust 后端管理 Codex 子进程；
- App Server 使用本地 stdio，不暴露网络监听端口；
- 写入默认限制在所选工作区，网络访问默认关闭；
- 凭据只在子进程启动时解析，日志和配置不包含明文；
- HarmonyOS 端只连接 HTTPS 企业网关，访问令牌默认仅保存在会话内。

架构与交付边界见 [`docs/architecture.md`](docs/architecture.md)，版本路线见 [`docs/roadmap.md`](docs/roadmap.md)。

## 开源协议与上游

本项目采用 Apache-2.0。Codex 运行时及其依赖遵循各自上游许可证；集成协议参考官方 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。“Codex”是其权利人的产品名称，本项目“昆仑增长”不是 OpenAI 官方发行版。
