# dsh 兼容性矩阵

本页记录 dshpack 依赖的外部契约，不把 preview 行为包装成永久 API。当前基线是
`@deepseek-ai/dsh@0.1.0-rc.6`；源码解释固定在
`deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`。

证据等级：

- **发布物实测**：在隔离临时 DSH_HOME 对 npm 发布物执行过。
- **源码 + 实测**：固定源码、官方测试和发布物结果一致。
- **源码确认**：题目允许只读源码确认，或尚留待 W14 做端到端实测。

| 我们依赖的契约 | rc.6 结论 | 证据等级 | 漂移检测 | 漂移处理 |
| --- | --- | --- | --- | --- |
| `DSH_HOME` 覆盖用户默认目录 | 所有探针均落入显式临时目录 | 源码 + 实测 | 所有 real smoke 先断言临时根；真实目录前后快照 diff | 立即阻断 smoke/install |
| `plugin --profile P list --depth=0` 初始化 | exit 0；创建标准三文件 | 源码 + 实测 E1 | fixture 对比文件集和必备行 | 停用初始化路线，评估官方模板复制 |
| 自定义 profile 基座 | 仅 `@deepseek-ai/dsh-base`；patch 为 `[]`；workspace 三项固定 | 源码 + 实测 E1 | fixture 结构断言 | 更新兼容矩阵，不自动改 fixture 迁就漂移 |
| 空 profile 初始化不产生 lock | 无 `pnpm-lock.yaml` | 发布物实测 E1 | 初始化后文件枚举 | 不把“缺 lock”误报为损坏；add 后再要求 |
| `plugin add` 在 profile cwd 运行 pnpm | staging 名可 add，使用 PATH 上 pnpm | 源码 + 实测 E2 | 记录 pnpm version、add exit 和 profile manifest | pnpm 版本不符即阻断 lock 采集 |
| profile 目录可 rename | rename 后 list 可用；manifest name 不自动变 | 发布物实测 E2 | rename 后 list + manifest 名断言 | 默认不用 staging 叶名直改最终名 |
| pnpm 11 npm lock | `resolution.integrity`，无 tarball | 发布物实测 E3 | `e3-npm/pnpm-lock.yaml` fixture | extractor 同时读 importer/package resolution |
| pnpm 11 GitHub lock | `gitHosted + integrity + codeload tarball`，无独立 commit 字段 | 发布物实测 E3 | `e3-git/pnpm-lock.yaml` fixture | 从 specifier/key/URL 交叉取并验证 40 SHA |
| pnpm 11 直接 HTTPS tarball lock | `integrity + tarball`；registry tgz 可归一化为 npm 形状 | 发布物实测 E3 | `e3-tarball/pnpm-lock.yaml` + registry 归一化探针 | 不要求 tarball 字段恒存；保留 source intent |
| settings 锁名 | 目标文件路径直接追加 `.lock` | 源码 + 实测 E4 | 并发探针输出 `lockSuffix` | 名称漂移则停用 settings 写入 |
| settings writer lock | PID 换行、0600、`wx`；20→200 ms，总 2 s；不偷 stale lock | 源码 + 实测 E4 | busy/stale lock 探针 | 超时或抢锁语义漂移时禁用写入 |
| settings 原子替换 | 同目录 12 hex temp + rename；无 fsync | 源码确认 E4 | 上游 atomic-write 源码审计 + failure test | 文档如实更新，不声称 crash durability |
| 跨 writer 不同 namespace | 并发后两 namespace 和最终值都保留 | 发布物实测 E4 | `probe-settings-lock.mjs` | 失败则禁用默认 preset 写入 |
| 同 namespace 并发 | last-write-wins，不提供值级 merge/revision | 源码确认 E4 | 上游 README/测试漂移检查 | 锁内重读并只改目标叶，文档保留限制 |
| MCP patch 行 | `- insert:` 下完整 `{id,name,config}` row | 源码 + 实测 E5 | dump 命中 + 故障端点 boot 到 MCP 连接阶段 | loader/module 失败则把 MCP 降为文档指引 |
| MCP client 供给 | rc.6 CLI 自带 `@deepseek-ai/dsh-mcp-client@0.1.0-rc.6` | 发布物实测 E5 | boot 错误必须来自连接阶段而非 module-not-found | 不硬 pin历史 rc.1；跟随 dsh contract |
| `dsh --version` | stdout `0.1.0-rc.6\n`、stderr 空、exit 0 | 发布物实测 E9 | weekly `smoke-real-dsh.mjs` 精确比较 | 红灯视为契约漂移，不自动放宽解析 |
| 已初始化、未启动 profile 的 dump | 两种 dump 均可用，输出顶层 YAML array | 源码 + 实测 E9 | weekly built-in default dump + W3 custom fixture | dump 失败时 export 降 opaque patch |
| 完全不存在的普通 profile dump | 两种均 exit 1，不初始化 | 源码 + 实测 E9 | missing-profile 负例 | install 必须先走 E1 |
| doctor 写入面 | dump 不启动 app，但 dsh 可生成/重写 profile `cordis.yml`；每次 dsh 调用还会由 dshpack 写 `.dshpack/logs/<file>` 审计日志 | 源码 + 实测 E9 | 干净 DSH_HOME 前后枚举并按 `owner: dsh \| dshpack` 披露 | 不再称“严格只读”；只在隔离/目标 profile 执行，并保留审计日志 |
| `agent-presets` Web 可见性 | 不在 literal WEB 数组；在 PRODUCT 集合并进入最终 allowlist | 源码 + 官方测试 E10 | 检查三集合与 `settings.update` 官方测试 | literal/effective 分开记录；未知 namespace 禁用 |
| preset 内 skills 注入 | `customSkillDirs` 使用 `!!js` + `baseUrl` | 源码确认 E7，待 W14 | W14 启动 preset 并查 catalog | 未实测前不发布 starter |
| 官方 preset 复制 | 目录 id + composition + metadata + 可选 skills/assets；MIT | 源码确认 E8，待 W14 | W14 copy/load + NOTICE 审计 | 保留许可文本；结构漂移停止派生 |

## 自动检测入口

- 普通 CI（Windows + Ubuntu）：`pnpm check`、coverage、e2e、package dry-run。
- weekly/manual：`DSH_REAL_SMOKE=1 node scripts/smoke-real-dsh.mjs`，使用全新临时
  DSH_HOME，精确检查 version 和 built-in `--dump-default-config` 形状。
- W3 fixtures 带逐文件 provenance；更新任何 fixture 时必须重新运行隔离探针并人工审计 diff。
- preview 升级出现红灯时，先更新本矩阵和 ADR，再决定适配；禁止只放宽断言制造绿灯。
