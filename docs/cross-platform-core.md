# 昆仑增长跨平台核心

跨平台核心不依赖桌面页面或操作系统。它被 Windows、macOS、HarmonyOS 的发行层共同调用；平台层仅实现系统凭据库、安装器、托盘、通知和文件选择。

## 核心边界

1. **运行时管理**：锁定 `@deepseek-ai/dsh`，使用隔离的 `DSH_HOME`、loopback Web 端点与健康检查；Codex App Server 只作为独立可选运行时。
2. **插件与连接器**：Obsidian、飞书、模型网关、MCP、Skills 和工作流都以 `ConnectorManifest` 描述能力、授权范围、依赖和凭据引用。
3. **治理**：每次连接器能力调用都先经过 `evaluateGovernance()`；未批准插件、越权能力、缺失凭据、未白名单域名和限制级数据外发默认拒绝。
4. **凭据与审计**：清单仅保存凭据引用，实际密钥仅来自系统凭据库或企业网关；审计值先脱敏。
5. **升级与恢复**：运行时和插件使用同一份完整性清单；默认禁止降级，只有明确的回滚操作才能替换为较早版本。

## 当前可执行门禁

```powershell
npm run dsh:check
npm test -- --run
cargo test --lib --manifest-path src-tauri/Cargo.toml
```

完整 DSH 依赖锁和离线包缓存是正式 Windows 安装器的发布前门禁；不得以用户机器的全局 Node、全局 `dsh` 或 `npx` 代替。
