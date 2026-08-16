# Starter Pack Certification — W15b

认证日期：2026-08-17。全部 `dsh` 调用都显式设置到隔离的临时 `DSH_HOME`；未读取、写入或列举用户的真实 DSH_HOME。

原始 stdout、stderr 与每条退出码已提交至 [`docs/adr/stage8-raw/`](adr/stage8-raw)。`--dump-config` 均为安装后的全新真实 `dsh` 进程调用。

| OS | Starter pack | `dsh` | 命令与 exit code | 关键断言 |
| --- | --- | --- | --- | --- |
| Windows（原生） | `web-dev` | `0.1.0-rc.6` | `install --as web-dev --yes` → 0；`dsh --profile web-dev --dump-config` → 0；`doctor --profile web-dev --strict --json` → 0 | dump 包含 `mcp-context7`、`@deepseek-ai/dsh-mcp-client`、`serverName: context7` 和 `https://mcp.context7.com/mcp`；安装四个 web skill。 |
| Windows（原生） | `research-writing` | `0.1.0-rc.6` | `install --as research-writing --yes` → 0；`dsh --profile research-writing --dump-config` → 0；`doctor --profile research-writing --strict --json` → 0 | dump 中四个 Context7 标识均为 0 次；安装五个 research skill。 |
| WSL2 Ubuntu 24.04（原生 ext4） | `web-dev` | `0.1.0-rc.6` | `install --as web-dev --yes` → 0；`dsh --profile web-dev --dump-config` → 0；`doctor --profile web-dev --strict --json` → 0 | 同样命中四个 Context7 配置断言；安装四个 web skill。 |
| WSL2 Ubuntu 24.04（原生 ext4） | `research-writing` | `0.1.0-rc.6` | `install --as research-writing --yes` → 0；`dsh --profile research-writing --dump-config` → 0；`doctor --profile research-writing --strict --json` → 0 | 四个 Context7 标识均为 0 次；安装五个 research skill。 |

Windows capture 根为 `C:\Users\24020\Desktop\111\dshpack\.stage8-windows-smoke-20260817\captured-dsh-home-2`；Linux capture 根为 `/home/hili986/dshpack-smoke-stage8-20260817/captured-dsh-home-2`。两个 Linux pack、构建目录和运行目录均在 `/home/hili986/dshpack-smoke-stage8-20260817`，不在 `/mnt/c`。

两个 starter 仓均含已提交的确定性 lock，且本次在 Windows 上重复 `dshpack lock` 后 SHA-256 未变，随后 `dshpack validate --strict` 均为 exit 0：

- `web-dev`: `3414f1a chore: add deterministic pack lock`
- `research-writing`: `9ee2853 chore: add deterministic pack lock`

## Linux 用户态工具

WSL 使用官方 `node-v24.13.1-linux-x64` tarball，安装在 `/home/hili986/.local/node-v24.13.1-linux-x64`；实际验证的版本为 `v24.13.1`。为隔离 smoke，Corepack 缓存放在 `/home/hili986/dshpack-smoke-stage8-20260817/.stage8-corepack`，其 `pnpm@11.7.0` shim 放在 `.stage8-bin`；真实 `@deepseek-ai/dsh@0.1.0-rc.6` 安装在同一 smoke 根的 `dsh-runtime`。

未执行卸载，以保留证据。如要移除本批 Linux 用户态工具与 smoke 文件，运行：

```bash
rm -rf /home/hili986/.local/node-v24.13.1-linux-x64 /home/hili986/dshpack-smoke-stage8-20260817
```

未推送 starter 仓或本仓的任何提交。
