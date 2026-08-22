# 昆仑增长 DSH 运行时基线

## 决策

Windows 企业版以 DeepSeek Harness（DSH）为主 Agent 内核。昆仑增长不复制 DSH 的任务循环、会话或工具实现；它提供受控发行、企业策略和组织插件。

Codex App Server 继续作为独立可选运行时，不与 DSH 协议混用。

## 锁定版本

- 上游包：`@deepseek-ai/dsh`
- 锁定版本：`0.1.1-rc.2`
- 上游仓库：`https://github.com/deepseek-ai/deepseek-harness`
- 上游基线分支：`master`
- 上游许可证：MIT

完整性基线写入 [`runtime/dsh/upstream.lock.json`](../runtime/dsh/upstream.lock.json)。CI 和本地构建先执行 `npm run dsh:check`；版本、npm 完整性或上游提交改变时，必须由维护者重新审查并同步更新此文件。

运行时依赖在 `runtime/dsh/` 中独立锁定。应用主目录不得使用浮动的 `npx @deepseek-ai/dsh` 作为生产启动方式。

## Windows 发行原则

1. 安装器仅启动其自身管理的 DSH 子进程，并绑定至 loopback 地址。
2. DSH、昆仑插件和配置文件具有独立目录；卸载不得删除用户工作区或会话，除非用户明确选择。
3. 每次升级必须记录 DSH 版本、插件清单与完整性信息，并提供回滚入口。
4. 模型凭据只进入系统凭据库或企业网关；不得写入 DSH 项目配置、日志或会话导出。
5. 企业策略由昆仑插件在工具执行前强制执行，不能只依赖前端按钮隐藏。

## 首批昆仑企业插件

- `@kunlun-growth/dsh-provider`: 模型目录、企业网关、API 凭据引用。
- `@kunlun-growth/dsh-policy`: 工作区、Shell、网络、审批与白名单策略。
- `@kunlun-growth/dsh-audit`: 本地脱敏审计、会话导出和管理员上传队列。
- `@kunlun-growth/dsh-preset`: 团队 Skills、MCP 与工作流预置。

插件接口以 DSH 发布的 Cordis 服务与事件为准；在接入前必须用锁定运行时完成真实任务回归。
