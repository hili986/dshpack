# dshpack

把一个 dsh 场景——skills、MCP、profile patch、权限默认值——导出成一个**可安装、可分享、可审计**的 pack，再把 pack 装成标准的 dsh profile。

> **0.1.x 为预发布。** pack 格式与 CLI 参数都还不是稳定 API。作者向命令 `init` / `pack` 尚未实现。

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

| 命令 | 作用 |
| --- | --- |
| `dshpack install <source>` | 安装 pack；`--dry-run` 只出计划 |
| `dshpack list` | 列出 tracked / untracked / reserved / broken profile |
| `dshpack export --profile <p>` | 从现有 profile 导出 pack |
| `dshpack validate <path>` | 校验 pack 结构与 lock |
| `dshpack doctor` | 体检 DSH_HOME |
| `dshpack lock <path>` | 生成 / 更新 `pack.lock.yml` |
| `dshpack switch <profile>` | 校验并显示启动命令；`--run` 才真启动 |

来源支持本地目录、`github:owner/repo#<40 位 commit SHA>`、以及带 `sha512` SRI 的 HTTPS tarball。

## 它不做什么

- 不分发、不代理、不 fork `@deepseek-ai/dsh`；
- 不碰你真实的 `~/.dsh`——所有操作都要求显式的 `DSH_HOME`；
- 不把第三方 install/build script 当可信代码执行；
- 不热更新正在运行的 dsh 进程。

导出会三重扫描凭据；命中即以退出码 31 中止，**不会**"悄悄删掉"再交给你一个无法审计的 pack。

## 文档

完整说明、安全模型与贡献指南见仓库：<https://github.com/hili986/dshpack>

MIT
