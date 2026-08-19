# Contributing to dshpack

感谢参与。项目已发布 `0.1.1`，正处于 M1（包管理与自由组装）。首要目标始终是：可复现、可审计、且**永不触碰用户真实 DSH 状态**。

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

命令表里的 16 条命令**全部已落地**（`init` 与 `pack` 于 0.2.0 补齐），`exit 70` 现在只表示内部错误。下一条要加的是 `compose`。不要为了让示例“看起来可用”而让一个未实现的命令假装成功——**更不要让它假装失败之外的任何东西**：`init --version` 曾经退出 0 却什么都没做，这比报错危险得多。

## 测试纪律

这些不是风格偏好，每一条都对应一次真实的翻车。

- **每条测试都要能回答“删掉哪一行会让它变红”。** 答不上来的是装饰，不是钉子。新增“有界重试”“超时”“清理”这类**性质型**逻辑时，必须有一条测试直接钉住那个界——本仓曾把某个重试上限改成无穷，而整套测试照样全绿。
- **验证“挂死已修复”的测试必须自带独立安全阀**（超期主动抛错）。不要依赖 runner 的 `testTimeout`：纯微任务链会饿死事件循环，导致**挂死而不是超时**，testTimeout 救不了。
- **禁止低于全局的 per-test 超时覆写**。它会悄悄收回全局放宽的预算，并让失败信息里出现一个配置里根本查不到的数字。这条用例真的更慢，就抬全局。
- **超时红了，不要先调大超时。** 判据是：把上限改一个值，看耗时跟不跟着走。跟着走（给 20s 吃 20s、给 60s 吃 60s）是**阻塞**，抬上限只会把缺陷埋掉；稳定落在某个真实值才是**真慢**。
- **派生进程的测试只清理自己派生的进程**，且必须靠自己记下的 PID 来清，不得按进程名一锅端。
- **平台闸（`runIf(win32)` 等）不得沦为静默跳过。** 环境造不出输入时，要么让 CI 供给该性质，要么**显式报错并给出修复命令**——不要让断言在最需要它的平台上悄悄消失。
- **偶发失败先归因再修。** “跑第二次就过了”不算绿：在当前分支连跑 N≥3 次记录失败率，再 `git stash` 后在干净 HEAD 上跑同样次数。基线全绿而带改动高频红，才说明该改动是**触发器**；但根因常在别处（如套件并行度、既有的紧预算），**只修触发器等于把下一个人再坑一次**。

## 子进程

新增任何 spawn 之前，先读 [ADR-0003](./docs/adr/0003-subprocess-timeouts.md)。

一句话版本：**代码里写着 `timeout:` 不等于这条路径有界。** 要问的是“这个命令会不会派生孙进程”——`npx`、`.cmd` shim、Corepack、任何 launcher 包装器都会。会，就必须走 `awaitDirectChild`，否则孙进程持有继承来的管道时调用永不返回。同时**永不**终止进程树（`killDescendants` 恒为 `false`）：我们无法保证那棵树里只有自己派生的进程，误杀用户正在跑的 `dsh` 比挂死更糟。

## 命令行选项

新增子命令选项之前，先读 [ADR-0004](./docs/adr/0004-cli-option-namespace.md)。

一句话版本：**Commander 默认在子命令之后仍识别 program 级选项，因此 program 在任何位置都赢，子命令那份同名注册拿不到值。** 后果分两档——

- **纯值型**（`--json` / `--dsh-home` / `--quiet` / `--no-color`）：可以两级同名，但子命令**必须**同时读 `program.opts()`。照 `commands/init.ts` 里 `--json` 的既有写法（`options.json === true || root.json === true`），别只读 `options.x`。
- **会动作并终止解析的**（当前只有 `-V, --version`）：**禁止**同名，直接换名字加前缀——pack 版本号是 `--pack-version`。`init --version` 曾因此打印工具版本、退出 0、什么都不创建。（`--help` 不在此列：Commander 把它推迟到子命令分发之后，`init --help` 正确显示 init 自己的帮助。）

新增子命令只需把它加进 `cli.ts` 的 `commandDefinitions`，`COMMAND_NAMES` 与错位守卫会自动覆盖，**不要**手写第二份命令名清单。

还有一条与之配套：**工具打印给用户“直接复制运行”的每一条命令，都要有一条测试把它抓出来照原样跑，并断言产物**。只断言退出码不够——静默 exit 0 在退出码上和真成功一模一样。

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
