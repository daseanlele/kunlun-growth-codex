# 昆仑增长

面向企业 AI 落地的开源 Codex 工作台：一键安装，自主配置 API、模型和认证，并把命令审批、工作区隔离与企业策略放在本地可信边界中。

> 当前版本：`0.5.1` 可组合统一智能体工作台预览。Windows/macOS 共用 Tauri 桌面核心，以 Codex App Server 为主运行时；检测到本机或已捆绑的 DeepSeek Harness `dsh-acp` 后，DeepSeek 档案会自动走 ACP 适配层，不向普通用户暴露内核切换。未发现 Harness 时则使用受控原生 API 适配器。支持审批队列、Codex Review、搜索/归档/置顶、持久目标、任务分叉与实时追加指令、沙箱 PTY、图片输入、显式 Skill 调用、MCP 状态、账户与用量、工作区文件预览与 Git Diff 审阅，以及可显示、隐藏和排序的功能积木；HarmonyOS 提供连接企业 Agent Gateway 的原生 ArkTS 伴生端。

## 已实现

- React 19 + TypeScript 桌面界面与项目选择器；
- 官方 Codex App Server 的 stdio JSON-RPC 初始化、线程、任务与流式事件通道；
- 命令/文件操作审批响应；
- OpenAI、Azure OpenAI 与 OpenAI-compatible Provider 配置；
- Codex OAuth、Claude Messages API、DeepSeek/千问/Gemini/OpenRouter Chat Completions 适配器；
- 多模型档案、独立凭据引用、模型目录读取、流式输出、停止与本地会话历史；
- 原生模型可显式通过 `@相对路径` 读取受限工作区文件（最多 5 个、每个最多 24,000 字符预览）；
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

运行过 `npm run build` 后，也可以直接双击仓库根目录的 `index.html`；它会打开不依赖本地服务器的 `dist/offline.html` 单文件预览。

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

## 多模型适配边界

Codex / OpenAI Responses 适配器使用 App Server，因此具备完整的代理工具、审批、Skills、MCP、Review 与协作能力。Claude 与 Chat Completions 适配器使用各自原生 API，不会伪装为 Responses 协议；当前已支持流式多轮对话、模型发现、停止、受限 `@文件` 上下文，以及列目录、读文件、读 Git Diff 的工具循环。模型档案支持选择认证头名称（如 `Authorization`、`api-key` 或企业网关的 `X-API-Key`），密钥仍仅保存在系统凭据库。原生模型可请求创建或覆盖 UTF-8 文本文件；每一次写入都会在桌面端要求用户明确批准，路径严格限定在所选工作区，且不会删除或重命名文件。执行命令、网络访问、MCP 与子代理工具循环仍在接入中，未接入前不会绕过企业审批边界。

架构与交付边界见 [`docs/architecture.md`](docs/architecture.md)，版本路线见 [`docs/roadmap.md`](docs/roadmap.md)。

## 开源协议与上游

本项目采用 Apache-2.0。Codex 运行时及其依赖遵循各自上游许可证；集成协议参考官方 [Codex App Server 文档](https://developers.openai.com/codex/app-server)。“Codex”是其权利人的产品名称，本项目“昆仑增长”不是 OpenAI 官方发行版。
