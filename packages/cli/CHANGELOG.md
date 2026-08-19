# dshpack

## 0.2.1

### Patch Changes

- **修复：`dshpack init --version <x>` 会打印工具版本、退出 0、什么都不创建——而这正是工具自己让你复制的命令。**
  
  `init` 用 `--version` 接收 pack 版本号，但 `dshpack` 在 program 级注册了 `-V, --version`。
  Commander 默认在子命令**之后**仍然识别 program 级选项，于是 `--version` 被 program 吃掉：
  打印 `0.2.0`、退出 0、目录连建都没建。
  
  真正致命的是 exit 0。任何别的拼错（`--bogus`）都是 `unknown option` + exit 2，唯独这一个
  **假装成功**——包着 dshpack 的脚本读到的是"干完了"。而 0.2.0 在缺必填项时打印的那条
  "直接复制运行"的命令里，写的就是 `--version "0.1.0"`：**照着工具自己的建议敲，得到一个静默的空操作**。
  
  两处都修了：
  
  - `init` 的选项改名为 **`--pack-version`**（打印的那条可复制命令同步改对）。
  - 版本旗标出现在子命令之后时**直接拒绝**：`E_USAGE` + exit 2，并指明该用 `--pack-version`
    还是把 `--version` 挪到子命令之前。这一层保护所有子命令，不只是 `init`。
  
  `dshpack --version`、`--version --json`、`--` 之后的透传、以及子命令之后的 `--dsh-home`
  （README 快速上手与 `install` 生成的机器 argv 都用这个形式）全部保持原样。
  
  Commander 官方的 `enablePositionalOptions()` 能一次性关掉整类撞名，这里用不了：它会让
  `--dsh-home` 在子命令之后不再被识别，等于打断工具自己让人复制的那条 `install` 命令。
  
  漏到发布的原因值得记一笔：断言那条提示语的单测构造的是不带 `.version()` 的裸 `Command`，
  撞名在它里面结构上不可能出现；而用真实 program 的边界测试从没把版本旗标放到子命令后面试过。
  两类测试都在，只是没有一条同时跨过这两者。现在 `cli-boundary.e2e.test.ts` 会**把工具打印的
  那条命令原样抓出来跑一遍**，不硬编码任何旗标名字。
- @dshpack/core@0.2.1

## 0.2.0

### Minor Changes

- **新增 `dshpack init` 与 `dshpack pack`：从零创建一个 pack，并把它打成可分发物。**
  
  这两个命令从 M0 起就列在命令表里，但一直是空壳（`exit 70`）。补上之后，"做一个 pack"
  这条路第一次是完整的：`init` 起草 → `pack` 打包 → `install file:./dist/x.tgz` 装回来。
  
  **`dshpack init [directory]`**
  
  `--template minimal|skills|mcp|full` 四档模板，收尾自动跑 `lock` 与 `validate`，
  **任一道不过就把目录回滚到执行前的状态**（按全树指纹比对，不是删几个已知文件）。
  `--from-profile` 内部委托 `export`，不另写一份导出逻辑。
  
  非 TTY 环境**绝不提示**：缺必填项时以 `exit 21` 退出，并打印一条**可直接复制粘贴的完整
  `--yes` 命令**，而不是留下一句"缺少参数"让你自己拼。模板产物全部过凭据扫描，零命中；
  mcp 模板的 URL 是占位符且不含 userinfo。
  
  **`dshpack pack [directory]`**
  
  四道前置门（含 `validate --strict`）之后产出三件套：tarball、`.sha512` SRI 旁文件、
  以及 `manifest.json`（逐文件 sha256 的审计记录）。
  
  tarball 是**逐字节可复现**的——同一输入两次打包产出完全相同的字节。凭据扫描跑三次
  （收集前 / 写入前 / 写入后），任一次命中即 `exit 31` 且**不产出任何文件**；
  **绝不"悄悄删掉"命中的内容再打包**——那会造出一个不可审计的 pack。
  
  **本地 tarball 源**
  
  `install file:./dist/x.tgz` 现在可用，且**同样强制 SRI**，作者本地测试也不例外。
  篡改一个字节即被 integrity 检查拒绝。

### Patch Changes

- d9a743a: **修复：没装 `dsh` 的 Windows 机器上，`uninstall` / `doctor` / `switch` 会无限挂死。**
  
  这些命令都会 spawn 子进程，且都带 `timeout: 5000`，看上去是有界的。它们不是。`execa` 的
  `timeout` 到期只终止**直接子进程**；若该子进程派生了继承 stdio 的孙进程，孙进程在存活期间
  继续持有 stdout/stderr 管道，promise 要等流关闭才 settle，于是被 await 的调用**永不返回**。
  
  触发它的是一个再普通不过的用户状态：机器上**没有安装 `dsh`**。探测链因此落到兜底的
  `npx --yes @deepseek-ai/dsh`，而 npx 必然派生孙进程去下载并执行该包。`uninstall` 尤其严重——
  它在事务收尾跑 doctor 做装后校验，所以挂死发生在一次**已经在改你磁盘**的操作中途。
  
  修法是不再把库的 `timeout` 当作唯一保证：每次 spawn 都由本仓自己的看门狗兜底，到期标记超时、
  向直接子进程发 SIGTERM、**立即返回已收到的输出而不等流关闭**，并 `unref` 句柄以免继承管道
  把 CLI 吊住不退出。
  
  **没有**改成终止整棵进程树。Windows 上那是 `taskkill /T`，我们无法保证树里只有自己派生的
  进程——误杀你正在另一个终端里跑的 `dsh`，比挂死更糟。代价是超时路径的诊断输出可能是部分的，
  且可能残留一个短命的孤儿进程。决策与取舍记在 `docs/adr/0003-subprocess-timeouts.md`。
  
  这个缺陷在开发机上复现不出来：开发机装了 `dsh`，走的是快路径，从不进入兜底分支。它是在
  windows-latest 上被逮到的——三条用例**给多少预算就消耗多少**（给 20s 耗时 20s，给 60s 耗时
  60.4s），而这正是阻塞而非"慢"的签名。
- @dshpack/core@0.2.0

## 0.1.0

### Minor Changes

- M0 首个预发布版本。
  
  把一个 dsh 场景（skills、MCP、profile patch、权限默认值）导出成可安装、可分享、可审计的 pack，再把 pack 装成标准 dsh profile。
  
  已实现：`validate`（零写入且不调用 dsh）、`install`（带 journal 的可回滚事务，写入前先出完整计划）、`list`、`switch`（默认只打印启动命令，不 spawn）、`lock`（为手写 pack 生成确定性 `pack.lock.yml`）、`doctor`、`export`（三重凭据扫描，命中即失败而非静默脱敏）。`init` 与 `pack` 尚未实现。
  
  安全边界：GitHub 源只接受 40 位小写 commit SHA；HTTPS tarball 必须带 sha512 SRI；`--yes` 不能替代逐包 `--allow-build`、`danger-full-access`、`--replace` 或 `--allow-unverified`；build script 默认全禁。退出码区分 24（已干净回滚，重试安全）与 25（需人工恢复，不要重试）。
  
  pack 格式与 CLI 参数在 M0 尚不是稳定 API。已在 Windows 原生与 WSL2 Ubuntu 24.04 上对两个 starter pack 做过端到端认证。

### Patch Changes

- Updated dependencies
  - @dshpack/core@0.1.0
