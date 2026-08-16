# dshpack

## 0.1.0

### Minor Changes

- M0 首个预发布版本。
  
  把一个 dsh 场景（skills、MCP、profile patch、权限默认值）导出成可安装、可分享、可审计的 pack，再把 pack 装成标准 dsh profile。
  
  已实现：`validate`（零写入且不调用 dsh）、`install`（带 journal 的可回滚事务，写入前先出完整计划）、`list`、`switch`（默认只打印启动命令，不 spawn）、`lock`（为手写 pack 生成确定性 `pack.lock.yml`）、`doctor`、`export`（三重凭据扫描，命中即失败而非静默脱敏）。`init` 与 `pack` 尚未实现。
  
  安全边界：GitHub 源只接受 40 位小写 commit SHA；HTTPS tarball 必须带 sha512 SRI；`--yes` 不能替代逐包 `--allow-build`、`danger-full-access`、`--replace` 或 `--allow-unverified`；build script 默认全禁。退出码区分 24（已干净回滚，重试安全）与 25（需人工恢复，不要重试）。
  
  pack 格式与 CLI 参数在 M0 尚不是稳定 API。已在 Windows 原生与 WSL2 Ubuntu 24.04 上对两个 starter pack 做过端到端认证。

### Patch Changes

- Updated dependencies
  - @dshpack/core@0.1.0
