# Changelog

## 0.3.0

**自由组装第一次到用户手里。** `compose` 在仓库里躺了一阵、CI 一直是绿的，但它的 changeset 从没被消费过——直到这次发版号落在 0.3.0 而不是预期的 0.2.2，才发现它压根没发布过。去 0.2.1 的已发布 tarball 里 grep，`composeVersion` 出现 **0 次**。合并不等于发布。

### 新增

- **`dshpack compose [compose.yml]`** —— 按一份声明式清单，从多个来源取材组装成一个新 pack。做 pack 的第三条路：此前只能从自己的 profile 导出（`export`）或从零手写（`init`），没法从别人的 pack 取材而不 fork 它。

  三类来源可混用：`profile:<name>`（内部走 `export`）、`github:<owner>/<repo>#<40 位 SHA>` 与 `tarball:`（走 `install` 同一条获取链，**SHA 与 SRI 一样强制**）、以及本地目录。

  **冲突绝不静默。** 同一个 skill id 来自多个来源时 `exit 30` 并**列出全部冲突**，你必须在 `resolve` 里用 `rename` 或 `prefer` 明确裁决。"后来的覆盖先来的"是最容易写出来的行为，也是这里明确不做的——它会让 pack 的内容取决于 `include` 的书写顺序，而作者不会注意到。

  可直接跑的最小示例在 [`examples/compose/`](./examples/compose/)。CI 不只验它能组装，还验**删掉 `resolve` 后确实以 30 被拒**——只验前者的话，示例哪天退化成"其实没有冲突"也照样绿，而它要演示的东西已经悄悄没了。

### 修复

- **`status` 的 `shared` 改为按 profile 去重计数。** 原先按资产出现次数累加，于是同一个 profile 里两份内容相同的资产会把自己标成"共享"——可卸载这个 profile 时两份都会被删。这个数存在的意义就是回答"卸掉它会不会动到别人还要的字节"，旧算法**恰好在它要提示的那个动作上给出相反的答案**。引用计数意义上的共享属于 `gc` 的账本。

- **npm 页面上的 README 是过期的。** npmjs.com 展示的是 `packages/cli/README.md`，它仍写着 `init` / `pack` 未实现、命令表只列了 17 个里的 7 个——仓库根那份早已更新，两者之间没有任何东西连着。**这类缺陷任何行为测试都抓不到：工具是对的，对工具的描述是错的**，而它恰好落在用户的第一触点上。

  新增 `verify:readme-commands` 门禁，三条机械不变式：CLI 注册的每个命令必须在每份会被发布的 README 里被提及、任一 README 不得称已发布命令未实现、预发布说明必须跟随当前版本序列。它建好的当次就抓到了根 README 里另外两处同样没改干净的地方。

### 其他

- 真发布这一步现在有断言了：日志出现 `Skipped OIDC` 即失败，并向 registry 核对 `_npmUser` 为 OIDC bot、两个包都能解析出预期版本。此前只有 dry-run 验证 trusted publishing，**真发布静默回落到 token 与成功在日志上长得一样**。
- 发布后验证程序移进仓库 [`scripts/release-verification/`](./scripts/release-verification/)——此前它只活在临时目录里。它是本项目的**主检测器**：0.1.0 之后查出 5 个缺陷、0.2.0 之后 1 个，全都是 CI 看不见的。
- M1 的全部管理命令在 Windows 原生与 WSL2 Ubuntu 上各跑了一遍完整生命周期，8 步全过；跨平台摘要逐字节一致。

## 0.2.1

0.2.0 的 CI 是绿的，发布也是绿的。**然后我们把它从 npm 装回来，用装出来的二进制跑第一条命令——炸了。**

### 修复

- **`dshpack init --version <x>` 会打印工具版本、退出 0、什么都不创建。而这正是工具自己让你复制的那条命令。**

  `init` 用 `--version` 接收 pack 版本号，但 `dshpack` 在 program 级也注册了 `-V, --version`。Commander 默认在子命令**之后**仍然识别 program 级选项，于是 `--version` 被 program 吃掉：打印 `0.2.0`、退出 0、目录连建都没建。

  **真正致命的是 exit 0。** 任何别的拼错（`--bogus`）都是 `unknown option` + exit 2；唯独这一个**假装成功**——包着 dshpack 的脚本读到的是"干完了"，然后把不存在的产物往下游传。而 0.2.0 在缺必填项时打印的那条"直接复制运行"的命令里，写的就是 `--version "0.1.0"`：**照着工具自己的建议敲，得到一个静默的空操作。**

  两处都修了。`init` 的选项改名为 **`--pack-version`**，打印的可复制命令同步改对；版本旗标出现在子命令之后时**直接拒绝**（`E_USAGE` + exit 2），并指明该用 `--pack-version` 还是把 `--version` 挪到子命令之前——这一层保护所有子命令，不只是 `init`。

  `dshpack --version`、`--version --json`、`--` 之后的透传、以及子命令之后的 `--dsh-home`（README 快速上手和 `install` 生成的机器 argv 都用这个形式）全部保持原样。Commander 官方的 `enablePositionalOptions()` 能一次性关掉整类撞名，这里用不了：它会让 `--dsh-home` 在子命令之后不再被识别，等于打断工具自己让人复制的那条 `install` 命令。取舍与已登记的技术债记在 [ADR-0004](./docs/adr/0004-cli-option-namespace.md)。

  **为什么 1945 条测试全绿还能漏**，值得记一笔：断言那条提示语的单测构造的是不带 `.version()` 的裸 `Command`，撞名在它里面结构上不可能出现；而用真实 program 的边界测试从没把版本旗标放到子命令后面试过。两类测试都在，只是没有一条同时跨过这两者。

  现在有一条 e2e **把工具打印的那条命令原样抓出来跑一遍**，不硬编码任何旗标名字——将来拼写再变，它检查的仍是唯一要紧的事：我们给用户的那条命令能跑通。

## 0.2.0

"做一个 pack"这条路第一次是完整的，同时修掉一个会让人卡死的缺陷。

### 新增

- **`dshpack init [directory]`** —— `--template minimal|skills|mcp|full` 四档模板起草一个 pack，收尾自动跑 `lock` 与 `validate`，**任一道不过就把目录回滚到执行前的状态**（按全树指纹比对，不是删几个已知文件）。`--from-profile` 内部委托 `export`，不另写一份导出逻辑。

  非 TTY 环境**绝不提示**：缺必填项时 `exit 21`，并打印一条**可直接复制粘贴的完整 `--yes` 命令**——而不是丢一句"缺少参数"让你自己拼。模板产物全部过凭据扫描零命中；mcp 模板的 URL 是占位符且不含 userinfo。

- **`dshpack pack [directory]`** —— 四道前置门之后产出三件套：tarball、`.sha512` SRI 旁文件、`manifest.json`（逐文件 sha256 的审计记录）。tarball **逐字节可复现**，同一输入两次打包字节完全相同。

  凭据扫描跑三次（收集前 / 写入前 / 写入后），任一次命中即 `exit 31` 且**不产出任何文件**。**绝不"悄悄删掉"命中的内容再打包**——那会造出一个不可审计的 pack，而可审计正是这个工具的全部意义。

- **本地 tarball 源** `install file:./dist/x.tgz`，**同样强制 SRI**，作者本地测试也不例外。改一个字节即被 integrity 拒绝。

### 修复

- **没装 `dsh` 的 Windows 机器上，`uninstall` / `doctor` / `switch` 会无限挂死。**

  这些命令 spawn 子进程时都带 `timeout: 5000`，看上去有界。它们不是：`execa` 的超时只终止**直接子进程**，而该子进程若派生了继承 stdio 的孙进程，孙进程存活期间继续持有输出管道，promise 要等流关闭才 settle——于是调用**永不返回**。

  触发它的是个再普通不过的状态：机器上没有 `dsh`，探测链因此落到 `npx --yes @deepseek-ai/dsh`，而 npx 必然派生孙进程去下载执行。`uninstall` 最严重——它在事务收尾跑 doctor 做装后校验，所以挂死发生在一次**已经在改你磁盘**的操作中途。

  现在每次 spawn 都由自己的看门狗兜底：到期标记超时、向直接子进程发 SIGTERM、**立即返回已收到的输出而不等流关闭**。**没有**改成终止整棵进程树——Windows 上那是 `taskkill /T`，我们无法保证树里只有自己派生的进程，误杀你正在另一个终端跑的 `dsh` 比挂死更糟。代价是超时路径的诊断输出可能不完整，且可能残留一个短命孤儿进程。取舍记在 [ADR-0003](./docs/adr/0003-subprocess-timeouts.md)。

  这个缺陷在开发机上复现不出来（开发机装了 `dsh`，走快路径）。它是在 CI 上被逮到的——三条用例**给多少预算就消耗多少**（给 20s 耗时 20s，给 60s 耗时 60.4s），而这正是阻塞而非"慢"的签名。

## 0.1.1

第一个从 npm 装回来跑出的补丁。0.1.0 的流水线全绿，但把它装进隔离前缀、用**装出来的二进制**跑一遍，一次暴露五个缺陷——全都不在测试的射程内。

### 修复

- **`--version` 补上。** 0.1.0 完全没有注册这个 flag（`error: unknown option '--version'`）。现在 `dshpack --version` / `-V` 输出版本号，`--version --json` 把它放在 `version` 键下而不是塞进 `help` 文本。
- **`generatedBy` 不再是 `dshpack@0.0.0`。** 版本字面量原先在 lock、export、install 三处各写一遍，其中 install 那份从未更新，于是**每一次安装写进 `.dshpack/installed/<profile>.json` 的审计记录都标着 0.0.0**。三处统一到唯一来源 `src/version.ts`，并加了一条测试扫描源码拒绝任何 `dshpack@<数字>` 字面量。
- **`list` 不再误报。** 三处修正：
  - `profiles/node_modules` 是 dsh 启动器维护的扁平模块回退目录（dsh 自己在 `resolveProfileDir` 里直接拒绝这个名字），不再被当成 profile；
  - 非 profile 的目录与散落文件不再被枚举打分——判据改用 dsh 自己的那一条：**目录里有没有 `package.json`**；
  - `web` / `headless` 是 dsh 自带的保留 profile，健康得很，只是 dshpack 不接管。它们原先被"能不能作为安装目标"的命名规则判成 `broken 名称不符合安全规则`，现在是新状态 **`reserved`**。`broken` 一词只留给真正损坏的。

  被 dshpack 记录过、但目录已经不再是 profile 的情况**仍然报 broken**；`profiles/` 下的 junction 也**仍然报出来**，不会因为"看起来没有 manifest"被静默跳过。
- **`switch` 接受保留名。** 同一条错误规则也卡着 `dshpack switch web`——而 switch 只是校验并打印启动命令，不接管任何东西。
- **`homepage` / `bugs.url` 填的是真地址。** 0.1.0 两个包发布时都还是模板占位符 `https://github.com/<owner>/<repo>#readme`。
- **两个包都带上 README。** 0.1.0 的 npm 落地页是空白的。
- **移除死依赖 `validate-npm-package-name`。** 它从未被 import，却是唯一与声明的 `engines` 冲突的运行时依赖（要求 `^22.22.2 || ^24.15.0 || >=26.0.0`），害得每个用户装包时看到 EBADENGINE 警告。移除后 `>=22.19.0 <25` 与整个 47 个包的运行时依赖闭包完全自洽。

### 门禁增强

- release gate 增加**占位符 URL 拒绝**：原先只检查 `homepage` / `bugs` 是否*存在*，模板值堂堂正正通过了必填检查。
- release gate 增加 **tarball 必须含 README** 的检查。

### 兼容性

`list --json` 的 `status` 新增取值 `reserved`。原先落在 `broken` 里的保留名 profile 会改报 `reserved`，非 profile 目录不再出现在结果中。其余输出不变。

## 0.1.0

首次发布。`install` / `export` / `list` / `validate` / `doctor` / `lock` / `switch`，带回滚快照、凭据三重扫描与 npm provenance。`init` 与 `pack` 两个作者向命令尚未实现。
