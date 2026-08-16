# ADR-0002：固定 Node.js 与 pnpm 工具链

- 状态：Accepted
- 日期：2026-08-16

## 背景

`dshpack` 必须在 Windows、Ubuntu 和贡献者机器上生成一致的验证结果与包内容。浮动的运行时或
包管理器版本会改变 lockfile、lifecycle-script 策略和构建产物，也会削弱供应链变更的审计链。

## 决策

仓库采用：

- engines 为 Node.js `>=22.19.0 <25`；阻塞 CI 使用下界 `22.19.0`；本次本地验收实际使用
  `v24.13.1`，仍在声明范围内；
- pnpm 精确固定为 `11.7.0`，通过 Corepack 激活；
- TypeScript 固定 `6.0.3`。实测 `7.0.2` 把稳定 compiler API 拆到 unstable exports，导致
  tsdown 的 d.ts 插件类型失败；6.0.3 与 tsdown 0.22.14 的公开 peer range 一致；
- 依赖解析固定在根 `pnpm-lock.yaml`，CI 使用 `pnpm install --frozen-lockfile`；
- 第三方 GitHub Actions 使用完整 commit SHA，major tag 只保留为人类可读注释。

根 manifest 的 `packageManager` 是包管理器真源。CI 和贡献文档有意重复 pin，使不一致显式失败。

依赖版本精确保存。远端发布物必须携带 SRI，缺失或不匹配时 fail closed。opt-in 的
`@deepseek-ai/dsh@0.1.0-rc.6` contract smoke 是互操作探针，不进入 dshpack 发布依赖。

## 本机 Corepack 验证

系统 Node 位于受保护的 `Program Files`；直接运行系统级 `corepack enable` 得到
`EPERM ... C:\Program Files\nodejs\pnpm.CMD`。按“不扩权”红线，未提权修改系统目录。

先验证 registry 包本身可用：

```text
corepack prepare pnpm@11.7.0 --activate -> exit 0
corepack pnpm --version -> 11.7.0
```

随后在 gitignored 的仓库本地 prefix 安装同版 Corepack，将其 `.bin` 放在当前进程 PATH 首位，
实际运行验收要求的原命令链：

```text
corepack enable && corepack prepare pnpm@11.7.0 --activate
Preparing pnpm@11.7.0 for immediate activation...
exact_chain_exit=0
corepack --version -> 0.34.6
pnpm --version -> 11.7.0
```

CI runner 目录可写，继续使用标准全局 shim 激活；本地 fallback 不写 shell profile 或全局 npm 配置。

## 升级流程

工具链升级必须使用单一目的 PR：

1. 更新根 manifest 的 engine/package-manager 声明；
2. 用新 pin 重建 lockfile；
3. 更新 CI、README 兼容信息和贡献说明；
4. 在 Windows 与 Ubuntu 运行 `pnpm check`、coverage、e2e 和 `pnpm pack:dry-run`；
5. 在 PR 记录行为与 package 内容差异。

该 PR 不得混入无关功能。

## 后果

可复现性与可审查性提高，本地/CI 不一致更容易诊断。贡献者可能需要切换 Node 运行时；例行升级
需要协调配置、审查 lockfile 并跑完整跨平台 CI。
