# dshpack

把一个 dsh 场景——skills、MCP、profile patch、权限默认值——导出成一个**可安装、可分享、可审计**的 pack，再把 pack 装成标准的 dsh profile。

> **当前状态：M0，预发布，尚未发布到 npm。** pack 格式与 CLI 参数都还不是稳定 API。`init` 与 `pack` 两个作者向命令仍未实现。

## 它不做什么

- 不分发、不代理、不 fork `@deepseek-ai/dsh`；
- 不修改 dsh 上游仓库，也不碰你真实的 `~/.dsh`（所有操作都要求显式的 `DSH_HOME`）；
- 不把第三方 install/build script 当可信代码执行；
- 不热更新正在运行的 dsh 进程；
- 不把 preset 合进已有内容的 session，也不替你解决 session 迁移冲突。

## 安装前你会看到什么

`install` 在写任何东西之前先给出完整计划。下面是**真实输出**，对 [`dsh-packs/web-dev`](https://github.com/dsh-packs) 跑 `--dry-run` 得到：

```text
Will install web-dev@0.1.0 as web-dev
SOURCE: {"kind":"directory","path":"...\dsh-packs\web-dev"}
dsh: current=0.1.0-rc.6 tested=0.1.0-rc.6 mismatch=false
pnpm: current=11.7.0
asset skills/frontend-review -> skills/frontend-review action=create collision=false [热生效]
MCP context7: https://mcp.context7.com/mcp -> profile patch action=configure [重启生效]
default permissionPreset=workspace-write [仅空白会话]
write profiles/web-dev [重启生效]
write profiles/web-dev/cordis.patch.yml [重启生效]
write skills/frontend-review [热生效]
write .dshpack/installed/web-dev.json [热生效]
side-effect profiles/web-dev/cordis.yml: dsh --dump-config（E9）
rollback snapshot: enabled=true state=sha256-bSGmM1FiexZIOjjfdgjsYA14kw8egAI8O58sWTaWVro
```

每一行都带**生效时机**标签，因为这是 dsh 最容易踩的坑：skills 热生效，插件与 MCP 要重启新进程，preset 只对空白新 session 有意义。计划里还单列了 `side-effect`——那一行不是我们写的，是 dsh 自己在 dump 时重写 `cordis.yml`，我们只是触发方，但仍然要告诉你。

`--dry-run` 期间对 `DSH_HOME` 的写入数为 **0**。

## Quickstart

```sh
corepack enable pnpm
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm build

# 只读校验一个本地 pack（不调用 dsh，零写入）
node packages/cli/dist/bin.js validate --strict <pack-dir>

# 看安装计划，不写任何东西
node packages/cli/dist/bin.js install --dry-run --as demo --dsh-home <隔离目录> -- <pack-dir>
```

**始终传一个隔离的 `--dsh-home`**，不要拿你真实的 dsh 目录当试验场。

## 安全模型

这些不是承诺，是有测试锁住、且每条都有能让它转红的 mutant 的行为：

**来源必须可复现。** GitHub 源只接受 **40 位小写 commit SHA**——分支名、tag、短 SHA、甚至 40 位但含大写，一律 exit 20 且在任何子进程启动前就拒绝。HTTPS tarball 必须带 sha512 SRI，URL 不得含 userinfo。

**`--yes` 不能替代危险确认。** 它只能省掉那句"确定要装吗"。逐包的 `--allow-build`、`danger-full-access` 都仍需各自的显式授权；`--replace`（覆盖已有 profile）和 `--allow-unverified` 更是**硬门**——前者不给就不会发生，后者不给直接失败，都不走"提示一下"这条路。任何交互提示的默认值都是拒绝；非 TTY 环境下缺确认会 exit 21 并打印完整的非交互命令，不会把 CI 卡死。

**build script 默认全禁。** 依赖的 install/lifecycle script 只有在 pack 的 `allowBuilds` 里**逐个精确包名**列出、且你在安装时逐项授权后才会执行。父包、scope、或某个已授权的依赖，都不会把权限隐式传递出去。这是一份允许名单，不是 sandbox——放行一个 build script 等于允许该依赖以你的用户权限执行代码，所以它应该保持为空。

**凭据不外泄，也不"悄悄删掉"。** `export` 在收集前、写入前、写入后各扫一次，命中直接 exit 31 失败——**不会**替你删掉再给一个看起来干净、实则不可审计的 pack。诊断只给 `path:line:column`，**绝不回显命中的值**。扫描分五层：敏感键名、已知 token 形状（含 GitHub / npm / AWS / Google / Stripe / Slack / OpenAI 前缀）、`Bearer|Basic`、URL userinfo，以及基于 Shannon 熵的未知格式兜底。

> 一个刻意的取舍：32/40 位十六进制串与 UUID **不**被判为凭据。它们与 pack 强制要求的 40 位 commit SHA、校验和、以及各种合法 id 完全同形，纳入检测会让每个 pinned source 都误报。所以残余暴露面可以精确表述为：凭据要**同时**"存放在非敏感键名下"**且**"形状与合法标识符碰撞"才可能漏。

**装坏了能退回去。** `install` 是一个带 journal 的事务。任一步失败都会回滚：新 profile 移进 `$DSH_HOME/.dshpack/backups/<txid>/`（**不删除**），`--replace` 场景把原 profile 原样 rename 回去，skills/presets 只清理本次事务创建的项，settings 用保存的原文原子恢复。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 用法 / schema |
| 10 | 环境（Node / pnpm / dsh 不可用） |
| 20 | source、网络、完整性 |
| 21 | 用户拒绝，或非交互环境缺少确认 |
| 22 | profile 冲突或锁 |
| 23 | dsh 子进程失败 |
| **24** | **装后验证失败，但已干净回滚** —— 机器状态等同安装前，**重试是安全的** |
| **25** | **需人工恢复** —— 机器停在中间态，**不要盲目重试**，先按打印的恢复路径处理 |
| 30 | 契约（patch / skill / settings / profile） |
| 31 | 安全（路径 / 凭据） |
| 70 | 内部错误 |

24 和 25 必须分开：自动化拿到退出码就要决定要不要重试，而这两种结局要求的响应恰好相反。JSON 输出里的 `status` 也区分（`rolled-back` / `rollback-failed`），但不该要求调用方解析 stdout 才知道能不能重试。

## 命令

| 命令 | 作用 | 副作用 |
|---|---|---|
| `validate <source>` | 校验 pack 格式、来源、完整性、凭据 | **零写入，且不调用 dsh** |
| `install <source>` | 按计划以可回滚事务安装 | 见上方计划输出 |
| `list` | 列出 tracked / untracked / broken profiles | 只读 |
| `switch <profile>` | 校验并**打印**启动命令 | 默认不 spawn、不改 session；只有 `--run` 才前台启动 dsh |
| `lock [dir]` | 为手写 pack 生成/更新 `pack.lock.yml` | 只写该目录，产物确定且幂等 |
| `doctor` | 诊断环境与配置边界 | **会写**，见下 |
| `export` | 把 profile 导出成本地 pack | dsh dump 会写 `profile/cordis.yml` |
| `init` / `pack` | 作者向 | **未实现** |

`doctor` 的副作用要说清楚，因为它容易被误以为只读：走 `--dump-*` 的检查项会让 **dsh** 重写 `profile/cordis.yml`（不是我们写的，但由我们触发），而 **dshpack 自己**会在 `$DSH_HOME/.dshpack/logs/` 写审计日志。`--json` 的 `sideEffects` 字段把两者都列出来并标注归属：

```json
[
  { "owner": "dsh",     "path": "profile/cordis.yml" },
  { "owner": "dshpack", "path": ".dshpack/logs/<file>" }
]
```

全命令支持 `--dsh-home`、`--no-color`、`--quiet`、`--json`。JSON 模式下 stdout 只有一个 object，进度走 stderr。

## pack 目录长什么样

pack 目录里的文件分三类，各有各的待遇：

| 类别 | 成员 | 布局校验 | 会被部署 | 进 lock | 过凭据扫描 |
|---|---|---|---|---|---|
| pack 语义文件 | `pack.yml`、`pack.lock.yml`、`skills/`、`patch/`、`settings/` | 未知项**拒绝** | 是 | 是 | 是 |
| 仓库常规物 | `README*`、`LICENSE*`、`.gitignore`、`.github/`、`CHANGELOG*` | 允许 | 否 | 否 | **是** |
| 完全忽略 | `.git/`、`node_modules/` | 不遍历 | 否 | 否 | 否 |

第二类**允许但不部署**，然而**照样要过凭据扫描**——README 里贴了 token 是真实且常见的事故。第三类是根本不进去，不是"进去了再忽略"。

`pack.lock.yml` 是必需的，且应当提交进 git。手写的 pack 用 `dshpack lock` 生成。

JSON Schema 随 `@dshpack/core` 一起发布，可以直接 resolve：

```js
import schema from '@dshpack/core/schemas/pack.schema.json' with { type: 'json' };
```

它由 TypeBox 真源生成，发布前会解包 tarball 逐字节比对——**schema 必须在包里，且必须与真源一致**，两个方向都有断言。

## Starter packs

两个示例 pack 在 [`dsh-packs`](https://github.com/dsh-packs) org：`web-dev`（四个前端 skills + 零凭据的 context7 文档检索 MCP）与 `research-writing`（五个研究写作 skills，**刻意不连任何 MCP**）。

两者都在 **Windows 原生**与 **WSL2 Ubuntu 24.04 原生 ext4** 上做过端到端认证：`install` → 新 dsh 进程 `--dump-config` 行全命中 → `doctor --strict` 全部 exit 0。矩阵与全部原始 stdout/stderr/exit code 见 [`docs/starter-pack-certification.md`](./docs/starter-pack-certification.md)。两个 pack 都**不声明 `allowBuilds`**——即没有任何 build script 被授权。安装它们时若出现要求授权 build script 的提示，说明来源不对，请中止。

`research-writing` 不连 MCP 是设计决定，不是没做完：研究场景处理的是未发表稿件与他人版权材料，任何 MCP 都意味着内容离开你的机器。真实 dump 里已验证它零 MCP 配置。

## 你需要知道的限制

1. **插件与 MCP 变更需要新的 dsh 进程**，不会热加载。skills 是热生效的。
2. **agent preset 只对空白新 session 生效**，不会补写或合并已有 session。M0 的两个 starter pack 都不带 preset。
3. **skills 是提示词内容，不是校验器**。`citation-verification` 告诉你怎么核实引用，但不会替你去核。
4. pack 格式在 M0 **不是稳定 API**。

## 平台

| 组件 | 版本 | 状态 |
|---|---|---|
| Node.js | `>=22.19.0 <25` | CI 用 22.19.0；真机实测覆盖 22.19.0 与 24.13.1 |
| pnpm | `11.7.0` | Corepack 固定 |
| dsh | `0.1.0-rc.6` | 契约 smoke 使用；非产品依赖承诺 |
| Windows | 原生 | 阻塞 CI + 真机认证 |
| Ubuntu | GitHub runner + WSL2 24.04 | 阻塞 CI + 真机认证 |

Windows 上开发命令应在 PowerShell 里直接可用，不依赖 Bash 专属语法、符号链接权限或大小写敏感路径。升级固定版本须走独立 PR，同步更新配置、lockfile、CI、本表与 [ADR-0002](./docs/adr/0002-toolchain-pins.md)。

## 故障排查

- `init` / `pack` 返回 `70`：这两个作者向命令尚未实现。
- **exit 10 `E_PROBE`**：`dsh` 或 `pnpm` 不在 PATH 上。注意 Windows 上可能同时存在无扩展名的 `dsh` 与 `dsh.CMD`。
- **exit 25**：不要重试。先按输出里的人工恢复路径处理，机器处于中间态。
- 装完插件但 dsh 没变化：插件变更不热加载，必须完全退出并启动新的 dsh 进程。
- `pnpm install --frozen-lockfile` 失败：不要手改 lockfile，确认 Node/pnpm 固定版本后在依赖变更 PR 中重新生成。

报 issue 请给脱敏后的命令、版本、OS 和最小复现；**不要上传 token、真实 `.dsh` 或会话内容**。

## 贡献与安全

开发流程与验证命令见 [CONTRIBUTING.md](./CONTRIBUTING.md)。漏洞请走 [SECURITY.md](./SECURITY.md) 的私密渠道，不要开公开 issue。

[MIT License](./LICENSE)。
