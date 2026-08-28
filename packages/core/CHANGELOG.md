# @dshpack/core

## 0.5.4

## 0.5.3

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.1

## 0.4.0

## 0.3.0

### Patch Changes

- edabbdc: 修正发布到 npm 上的 README：它仍称 `init` / `pack` 未实现，且只列了 17 个命令中的 7 个
  
  仓库根 README 早已更新，但 npmjs.com 上展示的是 `packages/*/README.md`，两者之间没有任何东西连着——于是"工具是对的、对工具的描述是错的"这类缺陷不会被任何行为测试抓到。同时把根 README 里另外两处同样过期的断言（开篇横幅、故障排查条目）一并修掉。
  
  新增 `verify:readme-commands` 门禁：CLI 注册的每个命令必须在两份 README 里各被提及一次、任一 README 不得称已发布命令未实现、预发布说明必须写当前版本序列。
- edabbdc: `status` 的 `shared` 改为按 profile 去重计数
  
  此前按资产出现次数累加，因此同一个 profile 里两份内容相同的资产会把自己标成 shared。这个数存在的意义是回答"卸掉这个 profile 会不会动到别的 profile 还需要的字节"，而自己的两份副本会随它一起被删——旧算法恰好在它要提示的那个动作上给出相反的答案。引用计数意义上的共享属于 `gc` 的账，不是 `status` 的。

## 0.2.1

## 0.2.0

## 0.1.0

### Minor Changes

- M0 首个预发布版本。
  
  把一个 dsh 场景（skills、MCP、profile patch、权限默认值）导出成可安装、可分享、可审计的 pack，再把 pack 装成标准 dsh profile。
  
  已实现：`validate`（零写入且不调用 dsh）、`install`（带 journal 的可回滚事务，写入前先出完整计划）、`list`、`switch`（默认只打印启动命令，不 spawn）、`lock`（为手写 pack 生成确定性 `pack.lock.yml`）、`doctor`、`export`（三重凭据扫描，命中即失败而非静默脱敏）。`init` 与 `pack` 尚未实现。
  
  安全边界：GitHub 源只接受 40 位小写 commit SHA；HTTPS tarball 必须带 sha512 SRI；`--yes` 不能替代逐包 `--allow-build`、`danger-full-access`、`--replace` 或 `--allow-unverified`；build script 默认全禁。退出码区分 24（已干净回滚，重试安全）与 25（需人工恢复，不要重试）。
  
  pack 格式与 CLI 参数在 M0 尚不是稳定 API。已在 Windows 原生与 WSL2 Ubuntu 24.04 上对两个 starter pack 做过端到端认证。
