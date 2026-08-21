# 昆仑增长 HarmonyOS 端

原生 ArkTS Stage 模型应用，用于从 HarmonyOS 手机、平板和 2-in-1 设备连接企业部署的昆仑增长 Agent Gateway。

## 导入与运行

1. 安装最新版 DevEco Studio 与对应 HarmonyOS SDK。
2. 在 DevEco Studio 中打开本目录。
3. 配置签名与目标设备。
4. 运行 `entry` 模块。

应用只接受 HTTPS 网关地址。访问令牌仅保存在当前进程内，不会写入 Preferences；生产环境应由企业网关接入 OIDC/SSO，并用 HarmonyOS 安全能力保存刷新凭据。

本仓库的 `npm run harmony:check` 会进行不依赖 SDK 的结构检查。完整 HAP 编译与签名仍需 DevEco Studio、HarmonyOS SDK 和企业证书。
