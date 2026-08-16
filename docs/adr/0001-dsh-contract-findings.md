# ADR-0001：DSH 0.1.0-rc.6 契约实测

- 状态：Accepted for M0 W3
- 日期：2026-08-16
- 官方源码：`deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`
- 真机：Windows，Node `v24.13.1`，pnpm `11.7.0`，`@deepseek-ai/dsh@0.1.0-rc.6`

## 证据方法与安全边界

每项先读固定 commit 的官方源码，再运行 npm 发布物。所有 DSH 子进程均显式设置全新
`DSH_HOME=<TEMP>/dsh-home`；调用 `dsh plugin` 时把仓库内 Corepack shim 放在 `PATH`
首位，以保证子进程实际使用 pnpm 11.7.0。未读取或写入用户真实 DSH_HOME。

仓库只保存脱敏日志与 fixture。原始日志位于测试临时目录，可能含临时绝对路径，因此不入库；
`docs/adr/raw/*.sanitized.log` 和 `packages/core/test/fixtures/real-dsh/` 已替换用户名、机器名、
工作区/临时绝对路径和 anonymous-user-id，并扫描常见 token 前缀。

固定源码的 `apps/cli/package.json:4` 仍写 `0.1.0-rc.5`，而 npm 实测发布物是 rc.6。
因此源码用于解释机制，发布物输出用于裁决运行时事实。两者在本 ADR 涉及的代码路径上未发现行为冲突。

## E1：只读 plugin list 能否初始化标准 profile

### 问题

`dsh plugin --profile <全新名> list --depth=0` 是否初始化标准 profile；基座由哪些文件和必备行组成。

### 源码依据

- `apps/cli/src/plugin.ts:120-157`：缺失 profile 先初始化，再在 profile 目录运行原样 pnpm 参数。
- `packages/boot/app-boot/src/profile.ts:98-168`：profile 路径、名称校验、默认 bundle 和三个初始文件。
- `packages/boot/app-boot/tests/profile.spec.ts:58-72`：官方测试锁定创建内容与“不覆盖已有文件”。

### 实测命令

```text
DSH_HOME=<TEMP>/dsh-home PATH=<PNPM_11_SHIM>:<PATH> \
  <DSH_BIN> plugin --profile e1-fresh list --depth=0
```

### 原始输出摘要

- exit `0`；stderr：`dsh: initialized profile e1-fresh at <PROBE_ROOT>/.../e1-fresh`。
- 初始化后恰有 `package.json`（176 B）、`cordis.patch.yml`（217 B）、
  `pnpm-workspace.yaml`（61 B）；此时没有 `pnpm-lock.yaml`。
- `package.json` 必备内容：`name: dsh-profile-e1-fresh`、`private: true`、空
  `dependencies`、`dsh.profile.bundles: ['@deepseek-ai/dsh-base']`。
- patch 是两行说明注释加合法空顶层数组 `[]`。
- workspace 必备行：`packages: ['.']`、`nodeLinker: hoisted`、`autoInstallPeers: false`。
- 脱敏日志：`raw/e1-init.sanitized.log`；fixture：`e1-profile/`。

### 结论

成立。该命令可作为 install 第 5 步的官方初始化入口。`pnpm list` 没有依赖时不会生成 lockfile。

### 置信度

**已证实**（官方源码、官方测试、rc.6 发布物三重一致）。

### 对最终方案的影响

**确认原设计**。基座清单必须按上面的三文件和精确行验证，不能把后续 dump 生成的
`cordis.yml` 误认为 E1 初始文件。

## E2：临时 profile 名下 add 与原子 rename

### 问题

能否在 staging profile 名下执行 `plugin add`，结束后把目录原子 rename 为最终名。

### 源码依据

- `packages/boot/app-boot/src/profile.ts:98-110`：除空名、分隔符、`.`、`..`、`node_modules`
  外，普通 staging 名可用。
- `apps/cli/src/plugin.ts:104-112,120-157`：相对本地 spec 先锚定调用 cwd；pnpm 在 profile
  目录执行；成功后才 reconcile bundle。
- `apps/cli/src/plugin.ts:36-90`：声明 `dsh.bundle.patch` 的依赖会进入 bundles。

### 实测命令

```text
<DSH_BIN> plugin --profile e2-stage-20260816 add <WORKSPACE>/scripts/fixtures/w3-local-bundle
rename <TEMP>/profiles/e2-stage-20260816 -> <TEMP>/profiles/e2-final
<DSH_BIN> plugin --profile e2-final list --depth=0
```

### 原始输出摘要

- add exit `0`，明确显示 `pnpm v11.7.0`；本地 bundle 作为 dependency 安装并 reconcile。
- rename 后目录存在；以 `e2-final` 再次 list exit `0`，依赖仍可解析。
- 但 `package.json.name` 仍为 `dsh-profile-e2-stage-20260816`，不会随目录 rename 自动改名。
- 脱敏日志：`raw/e2-add.sanitized.log`、`raw/e2-after-rename.sanitized.log`。

### 结论

staging 名下 add 和目录 rename 在运行上可行，但直接 rename 会留下 manifest 名称漂移。

### 置信度

**已证实**。

### 对最终方案的影响

**需修改**：不要直接把“临时 profile 叶名 → 最终叶名”作为默认事务优化。优先在独立临时
`DSH_HOME` 中使用最终 profile 叶名，成功后搬运该目录；若仍 rename staging 叶名，必须显式
重写并验证 `package.json.name`，且记录该额外写入。原“最终名 + backup rename”保守路线不受影响。

## E3：pnpm-lock.yaml 与三种 resolution 形状

### 问题

profile 是否产生 lockfile；pnpm 11 的 npm、git、HTTPS tarball 在 lock 中是什么形状。

### 源码依据

- `apps/cli/src/plugin.ts:120-157`：dsh 只启动 PATH 上的 pnpm；成功后 reconcile。
- `apps/cli` 与 `packages/boot/app-boot` 没有写 `pnpm-lock.yaml` 的代码；lock 是 pnpm 产物。
- 官方根 `package.json:7` 固定 pnpm 11.7.0，但 dsh 运行时不自行强制版本。

### 实测命令

```text
<DSH_BIN> plugin --profile e3-npm add yocto-queue@1.2.2
<DSH_BIN> plugin --profile e3-git add \
  github:sindresorhus/yocto-queue#b07eac099753833b29d06c614149904445739776
<DSH_BIN> plugin --profile e3-tarball-direct add \
  https://github.com/sindresorhus/yocto-queue/archive/b07eac099753833b29d06c614149904445739776.tar.gz
```

### 原始输出摘要

三次均 exit `0` 且生成 `lockfileVersion: '9.0'` 的 `pnpm-lock.yaml`。因为测试包不是 dsh
bundle，dsh 如实警告“plain dependency”，但不影响 lock 事实。

```yaml
# npm
resolution: {integrity: sha512-...}

# github: spec
resolution:
  gitHosted: true
  integrity: sha512-...
  tarball: https://codeload.github.com/.../tar.gz/<40-char-commit>

# direct HTTPS tarball
resolution:
  integrity: sha512-...
  tarball: https://github.com/.../<40-char-commit>.tar.gz
```

额外危险边界：把 npm registry 的 `.tgz` URL 直接作为 spec 时，pnpm 11 会将其归一化为
普通 npm 记录，`resolution` 只剩 `integrity`；原 URL 仍在 importer 的 `specifier` 中。
git 记录也没有独立 `resolution.commit` 字段，commit 位于 importer specifier、package key 和
codeload URL。fixtures：`e3-npm/`、`e3-git/`、`e3-tarball/`。

### 结论

E1 初始化不会产生 lock；任一成功 add 会产生。三种源都有可用 integrity，但解析必须联合读取
importer specifier、importer version、package key 与 package resolution，不能只查
`resolution.integrity/commit/tarball` 的固定字段。

### 置信度

**已证实**（Windows + pnpm 11.7.0；跨 OS 字节稳定性留 W14）。

### 对最终方案的影响

**需修改**：lock extractor 不得期待 git 的 `resolution.commit`；registry tarball 也不得要求
`resolution.tarball` 必存。manifest/source intent 与 importer specifier 是必需证据，pack lock
仍可把解析后的 commit、URL、SRI 规范化为自身稳定字段。

## E4：settings 锁名、协议与并发

### 问题

确认 `<file>.lock` 精确协议和 rc.6 的真实竞争行为。

### 源码依据

- `packages/util/atomic-write/src/index.ts:35-64`：同目录 `<file>.<12hex>.tmp`，`wx` 写后 rename；
  失败清 temp；**没有 fsync**。
- `packages/util/atomic-write/src/index.ts:71-117`：锁是目标路径追加 `.lock`；内容为
  `process.pid + '\n'`，mode 0600、flag `wx`；20→200 ms 指数退避、总 2000 ms、无 jitter；
  不抢 stale lock，持有者 finally 删除锁。
- `packages/settings/settings-file/src/index.ts:183-228`：持锁覆盖重读、reconcile、render、原子替换、
  更新缓存；文件 0600、目录 0700。
- `packages/settings/settings-file/README.md:20-43`：读者不加锁；不同 namespace 不丢，
  同 namespace 仍是 last-write-wins。

### 实测命令

```text
DSH_HOME=<TEMP>/dsh-home node scripts/probe-settings-lock.mjs \
  <TEMP>/dsh-cli/node_modules <TEMP>/e4-settings
```

实测加载 npm rc.6 发布物中的 `@deepseek-ai/dsh-settings-file@0.1.0-rc.6`，两独立 provider
共享一个临时 settings 文档。

### 原始输出摘要

```json
{
  "concurrentNamespacesPreserved": true,
  "concurrentFinalValues": { "alpha": 5, "beta": 5 },
  "busyLockWaitedMs": 173,
  "staleLockTimeoutMs": 2195,
  "staleLockMessageMatched": true,
  "staleLockPreserved": true,
  "documentUnchangedAfterTimeout": true,
  "lockSuffix": ".lock"
}
```

原始无敏感输出保存在 `raw/e4-settings-concurrency.raw.log`。

### 结论

协议和并发保护成立；老锁不会被偷取，超时后原文档与锁均保持。官方协议不提供 crash durability
的 fsync，也不解决同 namespace 的并发语义合并。

### 置信度

**已证实**。

### 对最终方案的影响

**需修改**：§4.4 的 25→400 ms 与 fsync 描述不等价于官方实现，应改为 20→200 ms、总 2 s、
无 jitter，并删除“官方已有 fsync”的断言。锁没有随机 owner token，不能声称 finally 会验证后
“只删自己的锁”。`switch --set-default-preset` 可保留为显式 opt-in 写操作，但要写明同 namespace
last-write-wins，并在锁内重读后只修改目标叶。

## E5：profile patch 插入 MCP client

### 问题

只在 profile patch insert `@deepseek-ai/dsh-mcp-client` 行，是否能解析并实际进入 MCP client。

### 源码依据

- `packages/mcp/mcp-client/README.md:9-29`：官方 stdio/streamable-http 完整行示例。
- `packages/mcp/mcp-client/src/index.ts:55-128`：`serverName`、`transport` 与 HTTP `url` 必填。
- `packages/bundle/base/cordis.patch.yml:1-18`：新增行必须使用顶层 `- insert:` 包裹完整 plugin row。
- `apps/cli/package.json:43` 与 `apps/cli/reference/README.md:80`：CLI 自带该依赖，但默认不启用 server。

### 实测命令

profile patch：

```yaml
- insert:
    - id: mcp-e5-probe
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: e5probe
        transport: streamable-http
        url: http://127.0.0.1:9/mcp
        failOnStartupError: true
```

随后执行：

```text
<DSH_BIN> --profile e5-mcp --dump-config
<DSH_BIN> --profile e5-mcp
```

### 原始输出摘要

- dump exit `0`，第 315 行起完整出现 `mcp-e5-probe`、包名和 config。
- 真 boot exit `1`，错误明确到 `loader entry mcp-e5-probe
  (@deepseek-ai/dsh-mcp-client): mcp-client(e5probe): initial connection ... failed`，底层是故意设置的
  `127.0.0.1:9` 无效端口。这证明模块已解析并进入 MCP 连接阶段，而不是只通过 YAML dump。
- rc.6 CLI 实际携带的是 `@deepseek-ai/dsh-mcp-client@0.1.0-rc.6`；题目提到的
  `0.0.1-rc.1` 存在，但不应成为 dshpack 的硬 pin。

### 结论

patch-only 映射成立；无需再向 profile dependencies 添加 MCP client。每个 server 是一个独立
insert row，`id` 与 `serverName` 都必须唯一。server 的真实连通性仍由安装后 doctor/boot 验证。

### 置信度

**已证实**（解析、加载和连接入口均由 rc.6 发布物执行；测试端点故意不提供服务）。

### 对最终方案的影响

**确认原设计并补强**：精确采用上面的 `insert -> row -> config` 结构；不要硬 pin rc.1，改为
依赖当前 dsh CLI 提供的包并让 contract smoke 检测漂移。

## E9：version 与从未启动 profile 的 dump

### 问题

确认 `--version` 的精确格式，以及 dump 对“未启动”和“不存在”profile 的边界。

### 源码依据

- `apps/cli/src/args.ts:112-135`、`apps/cli/src/bin.ts:19-27`：Commander 直接打印 manifest version。
- `apps/cli/src/dump-config.ts:30-51`：default dump 只加 bundle；effective dump 再加 profile/home/argv。
- `packages/boot/app-boot/src/profile.ts:366-402`：普通缺失 profile 报错；web/headless 可模板初始化。
- `apps/cli/src/profile-boot.ts:98-102`：dump 会生成/重写 profile 的 `cordis.yml`。

### 实测命令

```text
<DSH_BIN> --version
<DSH_BIN> --profile e1-fresh --dump-default-config
<DSH_BIN> --profile e1-fresh --dump-config
<DSH_BIN> --profile e9-missing --dump-default-config
<DSH_BIN> --profile e9-missing --dump-config
```

`e1-fresh` 只做过 E1 初始化，从未启动 app；`e9-missing` 完全不存在。

### 原始输出摘要

- version：stdout 精确为 `0.1.0-rc.6\n`，stderr 空，exit `0`。
- 已初始化但未启动的 `e1-fresh`：两种 dump 均 exit `0`，各 313 行；因 patch 为空，
  两份输出字节相同。UTF-8/LF fixture 各 9,903 B；输出是顶层 YAML array，并以
  `# == @deepseek-ai/dsh-base` 标层。
- dump 后新增 223 B 的生成文件 `profiles/e1-fresh/cordis.yml`，所以 dump 不启动 app，
  但不是“零写盘”。
- 完全不存在的普通 profile：两种 dump 均 exit `1`、不创建目录，错误要求先运行
  `dsh plugin --profile e9-missing add <package>`。
- fixtures：`e9/`；失败日志：`raw/e9-missing-*.sanitized.log`。

### 结论

doctor 可把 stdout 去掉单个末尾换行后作为 SemVer。dump 在“已初始化、从未启动”时可用；
普通 profile 完全不存在时不可用。dump 会写生成的 `cordis.yml`，不能归类为严格只读命令。

### 置信度

**已证实**。

### 对最终方案的影响

**需修改**：doctor/导出必须区分 absent 与 never-started。install 先完成 E1 初始化再 dump；只读模式
文档应披露 `cordis.yml` 写盘。固定源码 manifest 的 rc.5 不能覆盖实测 rc.6 version 事实。

## E10：agent-presets 的 Web 可见性

### 问题

`agent-presets` 是否在 `WEB_SETTINGS_NAMESPACES` 白名单，以及最终是否能被 Web apiproxy 访问。

### 源码依据

- `packages/host/apiproxy/src/api-proxy.ts:116-128`：literal `WEB_SETTINGS_NAMESPACES` 不含
  `agent-presets`。
- `packages/preset/agent-presets/src/index.ts:38-44`：namespace literal 是 `agent-presets`。
- `packages/host/apiproxy/src/api-proxy.ts:248-256`：它进入独立的
  `PRODUCT_SETTINGS_NAMESPACES`。
- `packages/host/apiproxy/src/api-proxy.ts:1944-1955`：最终 exposed namespaces 合并 model、
  WEB 与 PRODUCT 三组。
- `packages/host/apiproxy/tests/api-proxy-config.spec.ts:433-445`：官方测试实际 update
  `agent-presets` 成功。

### 实测命令

按题目要求，本项只读固定 commit 源码与官方测试，不启动 Web UI。

### 原始输出摘要

literal Web 数组为 `agent-loop/shell/locale/permission/ui-conversation/ui-theme/
web-search-deepseek`；`agent-presets` 不在其中，但位于 PRODUCT 集合并进入最终 effective allowlist。

### 结论

对原问题的精确回答是：**不在 `WEB_SETTINGS_NAMESPACES` 数组本体，但在 apiproxy 最终白名单，
因此 Web 可见且可写。**

### 置信度

**已证实**（源码 + 官方行为测试；无需 Web UI 真机）。

### 对最终方案的影响

**确认 v0 `agent-presets` settings 对 Web 可见**，但文档不能把原因误写成“它在 Web 数组”。
M2 自有 namespace 仍会被挡住，必须进入官方允许集合或使用其他存储方案。

## E7（顺带）：preset 注入 skills

**源码推定、待 W14 实测。** `apps/cli/config/agent-presets/cordis/agent.cordis.yml:248-259`
给出的精确结构是在 `skill-filesystem` row 的 `config.customSkillDirs` 中放：

```yaml
- !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```

`packages/skill/skill-filesystem/src/index.ts:50-81,155-166,242-254` 证明类型是 `string[]`、
最终 resolve 为绝对路径且有确定扫描 rank。结论仅为源码推定，不提前实现 starter。

## E8（顺带）：官方 preset 模板结构与许可

**源码推定、待 W14 实测。** `packages/preset/agent-presets/src/discovery.ts:1-6,138-160`
表明目录名即 id、必需 `agent.cordis.yml`、可选 `preset.yml`；cordis 还含 `skills/`。
`packages/preset/agent-presets/src/authoring.ts:114-169` 明确支持 whole-directory copy。
仓库根 `LICENSE:1-20` 与 package manifest 均为 MIT；复制/修改允许，但分发实质性副本必须保留
DeepSeek copyright 和 permission notice。未复制任何官方 preset 到本仓库。
