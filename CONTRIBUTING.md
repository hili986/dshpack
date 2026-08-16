# Contributing to dshpack

感谢参与。项目处于 M0，首要目标是建立可复现、可审计且不会触碰真实 DSH 状态的开发基线。

## 开发环境

需要以下版本：

- Node.js `>=22.19.0 <25`（CI 固定验证下界 `22.19.0`）
- pnpm `11.7.0`（通过 Corepack）

```sh
corepack enable pnpm
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
```

不要使用 npm 或 Yarn 改写 `pnpm-lock.yaml`，不要提交本地 Corepack shim、coverage 或打包产物。

## 开发循环

新功能和 bugfix 优先先写失败测试。提交前运行与 CI 相同的阻塞检查：

```sh
pnpm check
pnpm test:coverage
pnpm test:e2e
pnpm pack:dry-run
```

M0 中 `dshpack --help` 是唯一可验证的 CLI 能力；八个功能命令仍应以 `exit 70` 表示未实现。不要为了让示例“看起来可用”而绕过该边界。

## 安全测试边界

- fixture 和临时 DSH home 必须位于测试创建的隔离目录。
- 默认测试不得执行 `dsh`，不得读取或修改用户真实 `.dsh`。
- 不得修改或写入 DSH 上游仓库、上游文档仓和原始实验/fixture 输入。
- 真实 DSH contract smoke 只允许在明确 opt-in 的隔离 CI job 中运行，且需要 `DSH_REAL_SMOKE=1`。
- 日志和 issue 中不得包含 token、真实配置或会话内容。

## 变更约定

- 保持单个源文件不超过 400 行；优先按职责拆分。
- 用户可见的包变更需要 Changeset，见 [`.changeset/README.md`](./.changeset/README.md)。
- 工具链固定版本的升级应单独提交，并同步更新 manifest、lockfile、CI、README 兼容矩阵和 ADR。
- 第三方 GitHub Actions 使用完整 commit SHA；远程发布工件必须验证 SRI。
- `allowBuilds` 新增或扩大属于安全敏感变更，PR 必须解释为何无法避免对应 build script。

## Pull request

PR 描述应包括：

- 行为和边界的简要说明；
- 对应测试与实际运行命令；
- Windows/Ubuntu 差异（如有）；
- 安全、兼容性或迁移影响；
- 用户可见变更对应的 Changeset。

请保持提交聚焦，不要顺手格式化或撤销无关的并行改动。

## 报告漏洞

不要在公开 issue 或 PR 中披露未修复漏洞。请按 [SECURITY.md](./SECURITY.md) 使用仓库的 private vulnerability reporting 渠道。
