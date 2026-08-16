# dshpack

`dshpack` 旨在为 DSH 提供可复现、可审计、跨平台的 pack 管理格式与 CLI。

> 当前状态：M0 仓库骨架。现阶段只验证 `dshpack --help`；功能命令是占位实现并以 `exit 70` 结束，不能用于真实配置。

## 非目标

`dshpack` 不会：

- 分发、代理或 fork `@deepseek-ai/dsh`；
- 修改 DSH 上游仓库、上游文档仓或用户真实的 `.dsh` 目录；
- 把任意第三方 install/build script 当作可信代码执行；
- 热更新一个正在运行的 DSH 进程；
- 把 preset 合并进已有内容的 session，或替用户解决 session 迁移冲突；
- 在 M0 阶段承诺稳定的 pack schema、registry 或安装行为。

## 前提

- Node.js `22.19.0`
- 由 Corepack 激活的 pnpm `11.7.0`
- Windows 或 Ubuntu；两者都进入阻塞 CI
- 只有 opt-in 的真实合约 smoke test 才需要 `@deepseek-ai/dsh@0.1.0-rc.6`

## 3 分钟 Quickstart

M0 仅提供仓库内开发验证，不提供可工作的安装示例：

```sh
corepack enable pnpm
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/bin.js --help
```

`export`、`install`、`list`、`switch`、`doctor`、`validate`、`init` 和 `pack` 将从 W10+ 分阶段落地。它们当前返回 `exit 70`；不要据此判断用户配置、pack 或 DSH 存在问题。

## “Will install” 安全示例

未来 `install` 在写入前必须展示可审计计划。以下仅描述安全契约，不是当前可执行输出：

```text
Will install
  pack:     starter@1.0.0
  source:   immutable release artifact
  integrity: sha512-<publisher-provided-base64-digest>
  plugins:  example-plugin@1.2.3
  preset:   starter (new empty session only)
  writes:   <isolated target paths listed individually>
  builds:   none (allowBuilds is empty)
  restart:  start a new DSH process after plugin changes
```

来源、SRI、目标路径或允许执行的 build script 有任何变化时，工具必须中止并重新生成计划。详见 [Security Policy](./SECURITY.md)。

## 命令

| 命令 | 目标职责 | M0 状态 |
| --- | --- | --- |
| `export` | 将受支持配置导出为 pack | 占位，`exit 70` |
| `install` | 按 “Will install” 计划安装 pack | 占位，`exit 70` |
| `list` | 列出可见 pack 或受管状态 | 占位，`exit 70` |
| `switch` | 切换受管 pack | 占位，`exit 70` |
| `doctor` | 检查环境和配置边界 | 占位，`exit 70` |
| `validate` | 验证 pack 格式、来源和完整性 | 占位，`exit 70` |
| `init` | 初始化新 pack | 占位，`exit 70` |
| `pack` | 生成可分发工件 | 占位，`exit 70` |

稳定参数、退出码细分和输出 schema 会在相应里程碑实现时文档化。

## 格式

pack 将使用带版本号的声明式格式。预期覆盖身份、来源、插件、preset、完整性和 build 授权；M0 尚未接受任何格式为稳定 API。下面是设计轮廓，不是当前 parser 输入：

```yaml
formatVersion: 0
name: starter
version: 0.1.0
description: 最小场景包示意。
author: dsh-packs
license: MIT
dsh:
  tested: [0.1.0-rc.6]
plugins: []
mcp: []
defaults:
  permissionPreset: workspace-write
```

最终 schema 必须能在不执行 pack 代码的前提下完成静态验证，并使 “Will install” 集合可被精确计算。

## `allowBuilds`

依赖 build/lifecycle script 默认禁止。未来只有 pack 中 `allowBuilds` 明确列出的**精确包名**才可获准执行；父包、scope 或某个已允许依赖不会把权限隐式传给其他依赖。任何 `allowBuilds` 变化都属于需人工审查的安全变更，并必须出现在 “Will install” 计划中。

这是一份允许名单，不是 sandbox。允许某个 build script 等同于允许该依赖以当前用户权限运行代码，因此应保持为空或最小化。

## Windows

Windows 是阻塞 CI 平台。开发命令应在 PowerShell 中直接工作，不依赖 Bash 专属的环境变量赋值语法、符号链接权限或大小写敏感路径。文本文件统一提交 LF；Windows 专属脚本可由 Git 属性声明其行尾。

测试和本地调试必须把 DSH home 指向隔离临时目录。不要拿 `%USERPROFILE%\.dsh` 做 fixture，也不要用真实用户目录验证占位命令。

## 兼容矩阵

| 组件 | 版本/平台 | 状态 |
| --- | --- | --- |
| Node.js | `>=22.19.0 <25` | CI 使用 22.19.0；本次 Windows 实测为 24.13.1 |
| pnpm | `11.7.0` | 由 Corepack 固定 |
| Ubuntu | GitHub-hosted runner | 阻塞 check |
| Windows | GitHub-hosted runner | 阻塞 check |
| DSH | `0.1.0-rc.6` | 仅 weekly/manual contract smoke；非产品依赖承诺 |
| dshpack schema | M0 draft | 不稳定且不可安装 |

升级固定版本必须通过独立 PR，同步更新配置、lockfile、CI、兼容矩阵和 [ADR-0002](./docs/adr/0002-toolchain-pins.md)。

## `starter`

`starter` 是计划中的最小示例 pack，用来演示可复现的插件集合、只面向空白新 session 的 preset，以及默认空的 `allowBuilds`。M0 仅保留这一文档意图；它不是已发布 pack，也不能被当前 CLI 安装。

重要限制：preset 只在创建**空白的新 session**时生效。它不会补写、覆盖或合并已有 session；需要 preset 的用户必须显式创建新 session。

## 故障排查

- `dshpack <command>` 返回 `70`：M0 功能命令仍是占位实现；先用 `dshpack --help` 验证入口。
- pnpm 版本不一致：重新运行 `corepack prepare pnpm@11.7.0 --activate`，再检查 `pnpm --version`。
- `pnpm install --frozen-lockfile` 失败：不要手改 lockfile；确认 Node/pnpm 固定版本并在依赖变更 PR 中重新生成。
- 安装插件后当前 DSH 没有变化：插件变更不会热加载，必须完全退出并启动一个**新的 DSH 进程**。
- preset 没有进入旧 session：这是预期边界；preset 只对空白的新 session 生效。

报告问题时请提供脱敏后的命令、版本、操作系统和最小复现；不要上传 token、真实 `.dsh` 或会话内容。

## 贡献与安全报告

开发流程和验证命令见 [CONTRIBUTING.md](./CONTRIBUTING.md)。漏洞请通过 [SECURITY.md](./SECURITY.md) 指定的私密渠道报告，不要创建公开漏洞 issue。

本项目使用 [MIT License](./LICENSE)。
