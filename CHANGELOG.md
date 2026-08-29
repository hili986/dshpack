# Changelog

## 0.5.6

**浏览器端诊断诚实化（M3.16）。** UI doctor 只读面此前把"设计上不启动 dsh"伪装成 DSH003"无法在 5 秒内执行 dsh --version"宿主故障；现显式 `skipDshHost` 跳过宿主探针，改 info 级如实诊断并指引命令行 `dshpack doctor`；本地只读检查保留，rejecting runner 留作纵深背底。

## 0.5.5

**M3.14：组合 Pack 的 provenance 不再因路径形态被静默丢弃；Pack/漂移详情页也不再把“尚未选择上下文”与“健康的零漂移”伪装成空白。**

- **provenance 贯通**：compose 对每个已选 skill 写入 `id` / `from` / `originalId` / `license`，并随 v1 安装标记投影到 `list` 的 Pack 详情；只显示 `github:` 与 `profile:` 的非本机来源，本机路径仍不穿过 UI 服务边界。
- **空态可解释**：直达 Pack 或漂移页会给出下一步引导；diff 成功且本地漂移、上游差异、生效不一致三项均为空时，明确说明“无漂移：本地内容与锁定一致”。中英双语、既有授权模型与两步确认均未改变。

**GitHub codeload 的逐条目 PAX provenance 钉可验证地通过，其他扩展元数据仍 fail closed。** M3.13 只容忍 GitHub 固定 commit 产生的同值 `comment`，不改变部署集合、归档扫描或确认模型。

### 修复

- **GitHub codeload per-entry PAX 窄放宽（M3.13）**：仅当来源已固定 GitHub commit、条目携带 global 头且 comment==pin、且有效 per-entry PAX 键集合 ⊆ 显式白名单（stat-bag：时间/属主/mode/设备号/charset/`path`/`size` 等）时才接受；`path` 为标准长路径机制，其值仍完整经过既有路径硬校验，provenance 钉在 global 头。install 全量提取与 compose 选择性提取共用此预检；白名单外 PAX 键、缺/错 global pin、非 GitHub 归档、未消费的 metadata、重复 global PAX 仍以 `ARCHIVE_UNSAFE` 拒绝。

### 安全

- 为 tar parser 的 metadata 事件和原始 header type 建立有界 FIFO 对齐；连续相同 per-entry PAX 可正确记账，global PAX 仍仅保留原先的一次消费语义。路径安全、凭据扫描、条目与字节上限、授权模型/token/两步确认均未改变。

## 0.5.4

**未知 license 的预览不再伪失败，写入确认仍是硬闸。** M3.12 将来源许可不明的可解释性与实际写入授权分开。

### 修复

- **`compose --dry-run` 的未知 license 语义**：遇到 unknown/unlicensed source 时保留 `W_COMPOSE_UNKNOWN_LICENSE`，但以 exit 0 完成预览；不再要求 `--allow-unknown-license`。
- **真正的 compose 写入仍 fail-closed**：不传 `--allow-unknown-license` 时，保留硬拒绝 `E_COMPOSE_UNKNOWN_LICENSE_CONFIRM`，exit 21 (`USER_DECLINED`)；该确认只回答 unknown license 的策略闸门。
- **组合预览反馈改进**：UI 的显式确认仅进入 compose 写入的 plan/apply 流程，preview 请求始终不带 `allowUnknownLicense`。输入改变后的过期预览说明与来源选择/冲突的即时客户端反馈更清晰；服务端 preview 和 plan/apply 的判定仍为准。

## 0.5.3

**compose 体验两轮整顿。** 0.5.2 发布后真实使用回收："点击预览没反应"与"界面太乱"两条反馈。

### 修复

- **进行中反馈（M3.10）**：点击"预览组合"立即 pending——按钮 disable + 双语提示"预览中：解析来源并下载归档，可能需要数十秒…"；`try/finally` 无条件恢复，revision 防过期守卫语义不变。skill editor 的 skills/content 加载同模式闭合；write-review 未动。
- **复选框布局 bug（M3.11）**：全局 `input { width: 100% }` 把 skill 复选框撑成整行大方块；`.compose-skill-option` 覆盖为行内对齐。

### 新增（M3.11，纯呈现层，服务端诊断一字未动）

- 来源卡片容器化（`.compose-source`，明暗双态），表单节奏统一。
- 同类 `E_ARCHIVE_ENTRY_SKIPPED` 折叠为一条可展开 `<details>`——SECURITY.md 的可见性承诺以可展开全量保留；诊断人话在前、裸 code 降级为弱化尾缀。
- 空 skills/空冲突不再渲染空标题；resolved source 的 40 位 SHA 截断显示 7 位，完整串在 `title`。
- 新类进静态类名 union 三重闭合（view.ts 类型 + dom.ts 白名单 + CSS），白名单测试同步。

### 安全

- M3.10/M3.11 共两条 Claude 自制 mutant（删 pending 置位、放宽 SHA 截断正则）红绿实测；授权模型/token/两步确认原样。

## 0.5.2

**大仓库可组合，预检上限可见。** 用户拿 dsh-desktop（12.6 MB、含大二进制）实测撞出的两轮。

### 修复

- 预检解压上限 12→**256 MiB**；超限以 `E_ARCHIVE_PREFLIGHT_CAP` 明示已解压字节数与上限，与真损坏的 `ARCHIVE_UNSAFE` 分诊；SECURITY 记数值与理由。
- 组合页本地校验错误在输入变化时**即时清除**，不滞留到下次点击。
- GitHub API 限流改为明确诊断（`SOURCE_GITHUB_RESOLVE_RATE_LIMIT`），提示固定 40 位 SHA 的绕过方式。

### 新增

- **compose 源选择性提取**：conventional skill 仓库只部署 `.agents/skills/<安全 id>/SKILL.md` 形路径；大二进制等非 skill 普通条目跳过不部署，`E_ARCHIVE_SELECTIVE_SKIPPED` 一次性报告跳过的条目数和字节数（dsh-desktop 实测：跳 603 项 / 13.7 MB）。被跳过的路径仍先过路径安全检查；`install` 的全量提取与全部上限一字不变。

### 安全

- M3.9 四 mutant + Claude 补的选择性 id 规则独立钉（放宽 id 正则必须变红）红绿实测。

## 0.5.1

**真实世界仓库可装，组合页错误归位。** 用户拿含 symlink 的 awesome 列表实测撞出的两轮修复。

### 修复

- 归档非普通条目（symbolic/hard link、设备、FIFO）**跳过、不部署、不跟随**，以带路径的 warning 告知跳了什么；`..`、绝对路径、损坏 header 仍整档 `ARCHIVE_UNSAFE`。含 symlink 的真实 GitHub 仓库从此可预览、可装。
- 组合页本地校验错误渲染在字段旁（不再只进顶部通知）；preview 诊断在组合视图内可见；Profile 名占位符给合法示例。
- 凭据熵层豁免"三段及以上纯字母斜杠散文"（taxonomy 标签误报使整个源 exit 31）；SECURITY.md 记为第二个已知局限，残余暴露面精确表述；含数字/符号的斜杠串仍被检测。

### 其他

- M3.7 纯测试闭合六文件逐文件 90% 分支门槛；门槛零降低、`c8 ignore` 保持 0。

## 0.5.0

**自由组合、Skill 编辑、贴网址就能装。** M3 + M3.5，用户真机反馈驱动的两轮功能。

### 新增

- 本机 UI 支持自由组合：多来源逐项选择 skill，预览来源可得内容、provenance 与全量冲突；冲突必须明确 `prefer` 或 `rename` 后，才可经既有 plan → 逐项授权 → apply 流程组装并安装。
- 本机 UI 支持 Skill 原文读取和编辑：profile 关联的 skill 列表显示 drift，编辑器以 textarea 属性装载文本；服务端限制为 `skills/<skillId>/SKILL.md`、256 KiB，并让保存结果保留为用户 drift。
- **裸 GitHub 网址自动解析**：`https://github.com/owner/repo` 与 `github:owner/repo`（无 SHA）被接受；默认分支 HEAD 解析成 40 位 SHA 后钉死——计划展示、lock 记录、确认窗口冻结 pin（防 HEAD 在审阅期间移动）。带 `#sha` 的既有形态一字不变。
- **`DSHPACK_TRUST_LOCAL_DNS=1` opt-in**：fake-ip/透明代理把 github 主机解析到保留地址段时，SSRF 预检默认拒绝（安全装置工作正常）；设置该变量即信任你自己的 DNS/路由，跳过该预检。`localhost` 与 IP 字面量仍拒绝；默认行为一字不变。

### 安全

- 八条 mutant 红绿证据：composePreview 写 `DSH_HOME`、skillId 放行 `..`、resolve 根目录越界、textarea 改 innerHTML、保存伪造 pack 归属、未设 opt-in 也跳过预检、自动解析不钉 SHA、opt-in 跳过 localhost 拒绝——全部变红后还原。
- SECURITY.md 增补 composePreview 只读边界、Skill 编辑路径闭合与 fake-ip opt-in 的语义和代价。

## 0.4.1

**浏览器界面精修 + 中/英切换。** 0.4.0 发布后真实使用一轮的回收，六处缺陷修复（用户截图两处 + 自查四处），界面从"能用的线框"变成产品形态。

### 修复

- **doctor 副作用归属不再视觉粘连**：改「所有者 / 路径」两列表格，各有表头。
- **install 输入有了引导**：来源格式占位符（本地目录 / `github:…#40位sha` / `tarball:…#sha512`）；填成 profile 名时**提交前**拦下并解释该选哪个操作。
- **漂移视图输入语义独立**：不再与写计划共用按钮，预览计划在该视图禁用。
- **"查看 Pack"入口修复**：真实 `list` 响应本就带不出 `packDetails`，入口永远不出现；现投影契约内的 manifest identity 与 effective lock——且刻意不透传安装来源的本机路径，provenance 显示安全空态。

### 新增

- **中/英运行时切换**：页头「中 / EN」，纯内存不持久化；chrome 全走封闭消息目录（`messages.ts`，非法 locale fail-closed），服务端诊断与错误码不翻译。
- 界面产品化：tab 导航、卡片、表格、状态/严重度徽标、明暗主题——依旧零依赖、CSS 完全静态、class 封闭白名单。

## 0.4.0

**M2：Pack 管理有了浏览器界面。** `dshpack ui` 从上一版的服务端骨架（只有 `POST /api`）长成了完整界面。这也是本工具第一次交付一个"读得懂的界面"：零运行时依赖，TypeScript + DOM 直写，构建产物是约 36 kB 的单文件——因为这个界面是危险授权的确认界面，用户想审计"我点的那个开关到底做了什么"时，应该读得懂发给他的那份产物。

### 新增

- **`dshpack ui` 浏览器界面**——四个只读视图：总览（每个 profile 的 tracked/untracked/reserved/broken、代际、漂移、共享、更新状态）、单 profile 的 diff（本地漂移 / 上游差量 / 生效不一致，逐资产 digest）、诊断（逐条 `path:line:column` + 副作用归属）、pack 详情（manifest / provenance / lock）。五个写操作（`install` / `uninstall` / `update` / `restore` / `gc`）共用一条 **plan → 逐项授权审阅 → apply** 流程。

  安全模型逐条钉死，核心是**界面不能成为比 CLI 更松的授权路径**：每项危险授权是独立开关且默认全关；不存在"全部同意"按钮；计划摘要变化（或 apply 收到 409）后已授权项清空、必须重新审阅；403 只高亮缺项、不自动补授权重放；授权不齐时执行按钮直接 disabled。判定全在服务端，"前端不会那么发"不是理由。

- **不可信内容只当文本**——第三方 pack 的任何字段（名称、描述、路径、诊断、URL）都经 `textContent` 渲染；全仓静态断言禁止 `innerHTML` 一族 API、禁止动态 CSS 通道、禁止 pack URL 变成可点链接；所有 UI 响应带 `Referrer-Policy: no-referrer`；token 只存在内存里。静态资源（页面与 bundle）与 API 一样过 token 闸。

- **发布物里真的有界面**——浏览器产物落进 `packages/cli/dist/ui/`，由 workspace 依赖图固定构建顺序；tarball 断言与装回验证第 ⑬ 步（用装回来的二进制真起 UI、token 双向拒绝、bundle 非空）双保险，防"本地能跑、装回来是空白"。

### 修复

- **gc 引擎的覆盖率门槛脆性**——ubuntu CI 曾因 `gc/engine.ts` 分支 89.86% 贴线变红。修法不是降门槛：补了三条真测试（锁内重扫的非预期错误原样上抛、adapter 中止的带诊断/无诊断两侧映射），抬到 91.81%，每条各带 mutant 红绿证据。

### 其他

- `packages/ui` 四个源文件进入逐文件 90% 分支门槛清单（`main.ts` 90.15% / `state.ts` 94.97% / `view.ts` 97.57% / `dom.ts` 33/33）。
- SECURITY.md 增补浏览器侧信任边界四条。

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
