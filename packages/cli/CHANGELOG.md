# dshpack

## 0.5.0

### Minor Changes

- 5ada58a: **贴 GitHub 网址就能装 + 代理网络 opt-in（M3.5）。** 用户裁决：功能性第一；安全机制不得让核心流程在用户网络环境里不可用。
  
  ### 新增
  
  - **裸 GitHub 来源自动解析**：`https://github.com/owner/repo`（容忍尾斜杠/`.git`）与 `github:owner/repo`（无 SHA）现在被接受；服务端把默认分支 HEAD 解析成 40 位小写 SHA 后**钉死**——计划/预览展示解析出的 SHA，lock/provenance 记 SHA，确认窗口内 re-plan/apply 用冻结的 pin（防 HEAD 在审阅期间移动的 TOCTOU）。带 `#sha` 的既有形态一字不变。
  - **`DSHPACK_TRUST_LOCAL_DNS=1` opt-in**：fake-ip/透明代理会把 github 主机解析到保留地址段， SSRF 预检默认拒绝这类回答。设置该变量后跳过"本地 DNS 回答为私有/保留段"的预检（`localhost`、`*.localhost`、IP 字面量**仍拒绝**）；默认行为一字不变。SECURITY.md「已知且刻意接受」节与 README 均写明语义与代价。
  
  ### 安全
  
  - 三条 mutant 红绿证据：未设 opt-in 也跳过预检 → 红；自动解析不钉 SHA → 红；opt-in 下 localhost 拒绝被跳过 → 红。
  - 失败保留分类：解析期的网络/仓库/限流错误仍走 exit 20 族诊断，不降级为通用契约码。
- 5ada58a: **浏览器界面支持自由组合与 Skill 编辑（M3）。** 用户裁决：写操作保留两步确认；"在界面里直接操作、自由组合"从 CLI 专属搬进 UI。
  
  ### 新增
  
  - **自由组合页**：增量添加来源（本地目录 / 固定 SHA 的 `github:` / 带完整性的 `tarball:`），预览逐来源可选 skill、provenance 与全量冲突（`composePreview` 严格只读，私有临时目录内组装，`DSH_HOME` 零写入）；冲突必须单选 `prefer`（可选来源）或 `rename` 后，才经既有 plan → 逐项授权 → apply 组装并安装为新 profile（复用 install 的 journal 事务）。
  - **Skill 编辑器**：profile 的 skill 列表标出已有 drift；等宽 textarea 属性装载原文；浏览器只提交 `profile` + 安全字符 `skillId` + 文本，服务端自行闭合到 `skills/<skillId>/SKILL.md`（白名单 + resolve 双重防护），256 KiB 硬上限；保存不重写 installed metadata，永远是你自己的 drift。
  
  ### 安全
  
  - 五条新闭合项各带 mutant 红绿证据：skillId 放行 `..`、resolve 根目录越界、preview 写 `DSH_HOME`、textarea 改 innerHTML、保存内容伪造 pack 归属——全部变红后还原。
  - SECURITY.md 增补 `composePreview` 只读边界与 Skill 编辑路径闭合两条。

### Patch Changes

- @dshpack/core@0.5.0

## 0.4.1

### Patch Changes

- dae1572: **浏览器界面精修 + 中/英切换。** 0.4.0 发布后真实使用一轮的回收：
  
  ### 修复
  
  - **doctor 副作用归属不再视觉粘连**：改为「所有者 / 路径」两列表格，各有表头。
  - **install 输入有了引导**：来源格式占位符（本地目录 / `github:…#sha` / `tarball:…#sha512`）；填成 profile 名时提交前拦下并解释该选哪个操作。
  - **漂移视图输入语义独立**：不再与写计划共用按钮；"查看 Pack"入口修复（真实 `list` 响应本就带不出 `packDetails`，现投影契约内的 manifest 与 lock，且不透传本机安装路径）。
  
  ### 新增
  
  - **中/英运行时切换**：页头「中 / EN」，纯内存不持久化；chrome 全走封闭消息目录，服务端诊断与错误码不翻译。
  - 界面产品化：tab 导航、卡片、表格、状态/严重度徽标、明暗主题——依旧零依赖、CSS 完全静态。
- @dshpack/core@0.4.1

## 0.4.0

### Minor Changes

- c427bf2: **M2：Pack 管理有了浏览器界面。** `dshpack ui` 从 M2-A 的服务端骨架长成了完整界面——这是"看"与"做"两条线同时落地的一次发版。
  
  ### 新增
  
  - **`dshpack ui` 浏览器界面**——总览（每个 profile 的 tracked/untracked/reserved/broken、代际、漂移、共享、更新状态）、单 profile 的 diff（本地漂移 / 上游差量 / 生效不一致，逐资产 digest）、诊断（逐条 `path:line:column` + 副作用归属）、pack 详情（manifest / provenance / lock）四个只读视图；`install` / `uninstall` / `update` / `restore` / `gc` 五个写操作共用一条 **plan → 逐项授权审阅 → apply** 流程。
  
    安全模型是这次的重点，逐条钉死：**界面不能成为比 CLI 更松的授权路径**。每项危险授权是独立开关且默认全关；不存在"全部同意"；计划摘要变化（或 apply 收到 409）后已授权项清空、必须重新审阅；403 只高亮缺项、不自动补授权重放；执行按钮在授权不齐时直接 disabled。判定全在服务端，"前端不会那么发"不是理由。
  
  - **零运行时依赖的前端**——不引 React / Vue / Vite，TypeScript + DOM 直写，构建产物是约 36 kB 的单文件。这是刻意的：这个界面是危险授权的确认界面，用户想审计"我点的那个开关到底做了什么"时应该读得懂发给他的那份产物。状态机是纯函数、渲染走描述树、落到 DOM 只有 `textContent` / `createElement`；第三方 pack 的任何字段都只当文本显示。
  
  - **token 不离开本页**——所有 UI 响应带 `Referrer-Policy: no-referrer`；静态资源与页面一样过 token 闸；pack 提供的 URL 渲染为纯文本而非链接；样式是唯一的内联静态 `<style>`，无任何动态 CSS 通道。浏览器产物落进发布包（`dist/ui/`），tarball 断言 + 装回探针双保险。
  
  ### 修复
  
  - **gc 引擎的覆盖率门槛脆性**——ubuntu CI 曾因 `gc/engine.ts` 分支 89.86% 贴线变红。修法不是降门槛：补了三条真测试（锁内重扫的非预期错误原样上抛、adapter 中止的带诊断/无诊断两侧映射），抬到 91.81%，每条各带 mutant 红绿证据。
  
  ### 其他
  
  - `packages/ui` 四个源文件进入逐文件 90% 分支门槛清单。
  - 发布后验证程序新增第 ⑬ 步：从 registry 装回来的二进制必须能真起 UI、token 双向拒绝、`Referrer-Policy` 在场、bundle 非空。

### Patch Changes

- @dshpack/core@0.4.0

## 0.3.0

### Minor Changes

- 8d61d23: **新增 `dshpack compose [compose.yml]`：按一份声明式清单，把多个来源的 skill 组装成一个新 pack。**
  
  这是"自由组装"的主入口，补齐了做 pack 的第三条路——此前只能从自己的 profile 导出（`export`）
  或从零手写（`init`），没法从别人的 pack 取材。
  
  三条来源可以混用：`profile:<name>` 读本机 profile（内部走 `export`）、
  `github:<owner>/<repo>#<40 位 SHA>` 与 `file:`/`tarball:`（走 `install` 同一套获取链，
  **SHA 与 SRI 同样强制**）、以及本地目录。
  
  **冲突必须显式解决，绝不静默**。同一个 skill id 来自多个来源时 `exit 30`，并**列出全部冲突**
  而不是只报第一个；在 `resolve` 里用 `rename` 改名或 `prefer` 指定来源。
  "后来的覆盖先来的"是最容易写出来的行为，也是这里明确不做的。
  
  **取不到就失败**。显式点名的 skill 在来源里不存在时报错并列出该来源可选的 id，不静默跳过。
  `skills: ["*"]` 展开为该来源全部。
  
  **每个素材都记 provenance**：`from` / `originalId` / `license` 写进产出的 `pack.yml`，
  `github:` 来源记的是完整 40 位 SHA。来源 license 不明时需要显式 `--allow-unknown-license`；
  与新 pack 声明冲突时如实列出，**绝不自动改写别人的许可声明**。
  
  组装后的全部内容过凭据扫描，命中即 `exit 31` 且**零产出**；收尾自动跑 `lock` 与 `validate`，
  任一道不过就整体回滚。`--dry-run` 只报告将取什么、有哪些冲突，不创建输出目录。
  
  来源失败会**保留 adapter 自己的分类**：篡改的 tarball 是 `SOURCE_INTEGRITY` / exit 20，
  不会被折叠成"你的 compose.yml 写错了"——自动化据退出码判断时，那个区别决定它该不该重试。
  凭据命中仍然压过一切，安全永不被降级为契约噪音。
  
  `--dsh-home` 与 `DSH_HOME` 与其余命令一致：**只有 `profile:` 来源才需要 home**，
  但只要提供了就在任何 I/O 之前校验（相对路径与控制字符一律 `exit 31`）。

### Patch Changes

- edabbdc: 修正发布到 npm 上的 README：它仍称 `init` / `pack` 未实现，且只列了 17 个命令中的 7 个
  
  仓库根 README 早已更新，但 npmjs.com 上展示的是 `packages/*/README.md`，两者之间没有任何东西连着——于是"工具是对的、对工具的描述是错的"这类缺陷不会被任何行为测试抓到。同时把根 README 里另外两处同样过期的断言（开篇横幅、故障排查条目）一并修掉。
  
  新增 `verify:readme-commands` 门禁：CLI 注册的每个命令必须在两份 README 里各被提及一次、任一 README 不得称已发布命令未实现、预发布说明必须写当前版本序列。
- edabbdc: `status` 的 `shared` 改为按 profile 去重计数
  
  此前按资产出现次数累加，因此同一个 profile 里两份内容相同的资产会把自己标成 shared。这个数存在的意义是回答"卸掉这个 profile 会不会动到别的 profile 还需要的字节"，而自己的两份副本会随它一起被删——旧算法恰好在它要提示的那个动作上给出相反的答案。引用计数意义上的共享属于 `gc` 的账，不是 `status` 的。
- Updated dependencies [edabbdc]
- Updated dependencies [edabbdc]
  - @dshpack/core@0.3.0

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
