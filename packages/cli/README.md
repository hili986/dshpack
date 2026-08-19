# dshpack

把一个 dsh 场景——skills、MCP、profile patch、权限默认值——导出成一个**可安装、可分享、可审计**的 pack，再把 pack 装成标准的 dsh profile。

> **0.2.x 仍为预发布。** pack 格式与 CLI 参数都还不是稳定 API。

```sh
npm i -g dshpack
dshpack --version
```

## 装之前你先看到计划

`install` 在写任何东西之前打印完整计划，每一行都带**生效时机**标签——skills 热生效，插件与 MCP 要重启新进程，preset 只对空白新 session 有意义：

```text
Will install web-dev@0.1.0 as web-dev
dsh: current=0.1.0-rc.6 tested=0.1.0-rc.6 mismatch=false
asset skills/frontend-review -> skills/frontend-review action=create collision=false [热生效]
MCP context7: https://mcp.context7.com/mcp -> profile patch action=configure [重启生效]
write .dshpack/installed/web-dev.json [热生效]
side-effect profiles/web-dev/cordis.yml: dsh --dump-config（E9）
rollback snapshot: enabled=true state=sha256-bSGmM1FiexZIOjjfdgjsYA14kw8egAI8O58sWTaWVro
```

`--dry-run` 期间对 `DSH_HOME` 的写入数为 **0**。

## 常用命令

**装东西进来**

| 命令 | 作用 |
| --- | --- |
| `validate <source>` | 校验 pack 格式、来源、完整性、凭据；零写入且不调用 dsh |
| `install <source>` | 按计划以可回滚事务安装；`--dry-run` 只出计划 |
| `switch <profile>` | 校验并**打印**启动命令；`--run` 才真启动 |

**管住已经装进来的**

| 命令 | 作用 |
| --- | --- |
| `list` / `status` | 列出 profile / 汇总受跟踪状态（默认不联网） |
| `diff <profile>` | 对比本地漂移与可选的上游差异 |
| `update <profile>` | 三路合并更新；你后来改过的内容不会被静默覆盖 |
| `restore <profile>` | 还原到某一代，不丢弃之后的修改 |
| `uninstall <profile>` | 卸载；**归属无法证明的内容一律保留** |
| `gc` / `migrate` | 回收无引用的块与过期代际 / 把 legacy metadata 升到 v1 |
| `doctor` | 体检 DSH_HOME（**会写**，`--json` 的 `sideEffects` 列出归属） |

**做一个 pack 出来**

| 命令 | 作用 |
| --- | --- |
| `init [dir]` | 四档模板起草；收尾自动 `lock` + `validate`，不过就整目录回滚 |
| `export` | 把现有 profile 导出成 pack |
| `compose [compose.yml]` | 从多个来源组装；**同名冲突必须显式解决**，否则 exit 30 |
| `lock [dir]` | 生成 / 更新 `pack.lock.yml`，产物确定且幂等 |
| `pack [dir]` | 打成可复现且带 SRI 的 tarball |

来源支持本地目录、`github:owner/repo#<40 位 commit SHA>`、以及带 `sha512` SRI 的 HTTPS tarball。

## 它不做什么

- 不分发、不代理、不 fork `@deepseek-ai/dsh`；
- 不碰你真实的 `~/.dsh`——所有操作都要求显式的 `DSH_HOME`；
- 不把第三方 install/build script 当可信代码执行；
- 不热更新正在运行的 dsh 进程。

`export` / `pack` / `compose` 每条产出路径都三重扫描凭据；命中即以退出码 31 中止且**零产出**，**不会**"悄悄删掉"再交给你一个无法审计的 pack。

## 文档

完整说明、安全模型与贡献指南见仓库：<https://github.com/hili986/dshpack>

MIT
