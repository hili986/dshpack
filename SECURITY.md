# Security Policy

`dshpack` 会读取并最终管理开发者工具配置，因此把来源、完整性和写入边界视为产品契约，而不是可选增强。

## 支持范围

项目仍处于 M0。安全修复只提供给默认分支和最新发布版本；尚未发布或已停止支持的快照不承诺回补。

## 私密报告渠道

请使用本 GitHub 仓库的 **Security → Advisories → Report a vulnerability** 私密报告入口。不要为未修复漏洞创建公开 issue，也不要提交真实 token、用户的 `.dsh` 目录、会话内容或其他敏感数据。

报告尽量包含：

- 受影响版本、操作系统和 Node.js 版本；
- 最小复现步骤和预期/实际行为；
- 可能的影响范围；
- 已做脱敏的日志、样例 pack 或完整性元数据。

维护者会在同一私密 advisory 中确认收到、讨论影响和协调披露。若仓库未开放 private vulnerability reporting，请只通过仓库所有者的 GitHub 联系方式请求一个私密渠道，不要在初次公开消息中附带漏洞细节。

## 供应链承诺

- CI 中第三方 GitHub Actions 必须使用完整 commit SHA，而不能只写可移动 tag。
- 发布依赖必须使用精确版本并由 `pnpm-lock.yaml` 锁定；CI 使用 `pnpm install --frozen-lockfile`。
- 下载或安装的远程工件必须携带并校验 SRI（优先 `sha512`）；缺失、格式错误或不匹配时必须 fail closed。
- 不通过管道执行未固定版本的远程脚本，也不把 scheduled smoke test 下载的外部包纳入发布产物。
- 依赖 build/lifecycle script 默认不获得信任；任何例外都必须通过精确包名列入 `allowBuilds`，并在审查中可见。

## “Will install” 承诺

在任何安装写入或获准的 build script 执行之前，`install` 先生成一份可审计的 “Will install” 计划（`--dry-run` 只出计划、零写入）。计划至少列出：

- pack、插件和 preset 的名称、来源、精确版本或不可变 revision；
- 每个远程工件的 SRI；
- 将创建、覆盖或保留的目标路径，**每项带生效时机标签**（热生效 / 重启生效 / 仅空白会话）；
- 将执行的 subprocess/build script 以及对应的 `allowBuilds` 授权；
- **非我方写入但由我方触发的副作用**（如 dsh 在 dump 时重写 `profile/cordis.yml`）；
- 回滚快照状态。

实际输入、下载内容或写入集合与计划不一致时必须中止并重新生成计划。

## 来源与授权边界

- GitHub 源只接受 **40 位小写 commit SHA**；分支、tag、短 SHA、含大写的 40 位串一律在任何子进程启动**之前**拒绝。HTTPS tarball 必须带 sha512 SRI，URL 不得含 userinfo。
- **`--yes` 不能替代危险确认**。逐包 `--allow-build` 与 `danger-full-access` 各自需要显式授权；`--replace` 与 `--allow-unverified` 是硬门（不给则不发生 / 直接失败），不走提示路径。任何交互提示默认值为拒绝；非 TTY 缺确认时 exit 21 并打印完整非交互命令。
- 权限**绝不**因 pack 内容或任务文本而自动升级。
- **`compose` 不放宽任何一条来源纪律**：它的 `github:` / `tarball:` 来源走的是 `install` 的同一套获取链，40 位 SHA 与 SRI 一样强制，在 schema 层就拒绝短 SHA、分支名、大写 SHA 与明文 http。来源失败会保留 adapter 自己的分类（篡改的 tarball 是 exit 20，不是通用契约码）——**自动化据退出码决定要不要重试时，这个区别是有意义的**；凭据命中仍压过一切，安全不会被降级为契约噪音。
- **归档条目按类型处置而非盲目跟随。** symbolic link、hard link、设备和 FIFO 等非普通条目从不部署、从不跟随，并以带条目路径的 warning diagnostic 告知用户跳过了什么；`..`、绝对路径、解析损坏的 header 等仍按整档 `ARCHIVE_UNSAFE` 拒绝。
- **compose 的非 pack 归档会选择性部署。** 对不含根 `pack.yml` 的来源，compose 仅部署安全 `.agents/skills/<id>/SKILL.md`；没有可组合 skill 时也只给出如实 warning、不会阻断其他来源。每个归档路径仍先做完整安全校验，非 skill 的普通条目不部署、不扫描，并以一条 `E_ARCHIVE_SELECTIVE_SKIPPED` warning 明示跳过的条目数与字节数；单文件、总量和条目数限制只计算部署集合。`install` 不使用这一模式，仍对完整 pack 归档执行全部条目、单文件与总量限制。
- **`compose` 不修改素材内容，也不改写别人的许可声明**。来源 license 不明时需要显式 `--allow-unknown-license`（`compose` 没有 `--yes`，这是一道硬门）；与新 pack 声明冲突时如实列出并原样写进 `provenance`。同名冲突必须在 `resolve` 里显式解决，否则 exit 30 并列出**全部**冲突——静默地"后来的覆盖先来的"会让 pack 内容取决于 `include` 的书写顺序，而作者不会注意到。`rename` 本身也不能制造新冲突。
- 本工具只终止自己派生的进程；不做进程树终止（Windows 上那等同 `taskkill /T`，会误杀用户正在运行的 dsh）。
- **DSH_HOME 及其每一级祖先都不得是 symlink / junction / reparse point**，否则拒绝——链接可在校验与写入之间被换掉，使"路径在根内"的判断失效。判据是**逐级 `lstat`**，不是把路径字符串和 `realpath` 比：Windows 上 8.3 短名（`C:\Users\RUNNER~1\…`）和不同大小写拼法指向的是同一个目录、中间一个链接也没有，字符串却不相等。无法探查的祖先按"有链接"处理（fail closed）。

- **归档原始 header 预检最多解压 256 MiB。** 这是 gzip 展开前的有界 DoS 防线；超过上限会以 `E_ARCHIVE_PREFLIGHT_CAP` 明示已解压字节数与上限，真实 header 损坏仍以 `ARCHIVE_UNSAFE` 拒绝。

## 凭据处理

- 每条产出 pack 的路径都扫**三次**——`export` 在收集前 / 写入前 / 写入后，`pack` 与 `compose` 同理（`compose` 的第三次在 lock 生成之后，因为 lock 正是生成器最可能回显它读到的东西的地方）。命中即 exit 31 失败且**零产出**，**绝不"悄悄删除"**去制造一个看起来干净、实则不可审计的 pack。
- 诊断只输出 `path:line:column`，**绝不回显命中的值**（包括任何 ≥8 字符子串）。
- pack 目录里的仓库常规物（`README`、`LICENSE` 等）虽不部署，**仍然要过凭据扫描**。
- **已知且刻意接受的局限**：32/40 位十六进制串与 UUID 在非敏感键名下不被判为凭据，因为它们与本工具强制要求的 40 位 commit SHA、校验和及各类合法 id 完全同形，检测会让每个 pinned source 误报。残余暴露面因此可精确表述为：凭据须**同时**满足"存于非敏感键名下"且"形状与合法标识符碰撞"才可能漏。报告此类样本前请先确认它不属于该已知类别。
- **第二个已知且刻意接受的局限**：熵兜底层不报告"三段及以上、每段纯字母、全文无数字与 `+_= ` 符号"的斜杠分隔散文（如 `UX/accessibility/consistency`）。这类值是分类标签而非不透明凭据，但斜杠计入符号类、混合大小写使其越过字母类门槛，熵兜底会把真实仓库里的 taxonomy 标签误报成凭据、使整个源 exit 31 不可安装。残余暴露面：一枚**纯字母、多段斜杠分隔、混合大小写且高熵**的凭据在该层不报——它仍须穿过敏感键名、已知形状、`Bearer|Basic`、userinfo 四层，且其余扫描路径不受影响。

## 本机 UI（`dshpack ui`）的信任边界

- **只监听 `127.0.0.1`**，没有放开监听地址的选项。断言读的是 socket 的实际绑定（`server.address()`），不是配置里那个字符串。
- 每次启动铸一枚 256 位 token，**每个请求都校验**，且校验发生在路由、方法判定与读取请求体**之前**。比较用 `timingSafeEqual`，长度不等时仍做一次等长比较，不通过时序泄漏长度。token 进脱敏表，不会出现在任何诊断里。
- 信任等价物写清楚：**能读到启动它的那个终端的人 == 能直接运行 CLI 的人。** UI 不新增信任假设，只是把已有的那一份搬过来。
- **UI 不是一条更松的授权路径。** 危险授权在 wire 上是**结构化的逐项列表**，`wire` 里**不存在**任何"全部同意"的表达；服务端逐项校验，缺哪项拒哪项并原样列出缺项。判定全在服务端——"前端不会那么发"不是理由。
- 客户端连夹带都做不到：请求体里出现 `yes` / `dryRun` / `dshHome` / `interactive` / `fix` / 任一 `allow*` 字段，在校验层直接拒绝。其中 `fix` 尤其要紧——`doctor` 是只读端点，`fix: true` 混进去会让它开始写。
- **授权只应答它点名的那一项。** 授予 `foo` 的构建不会应答 `foo-core` 的构建询问：匹配是精确的，与"父包、scope、或某个已授权的依赖都不会把权限隐式传递出去"同规。
- 写操作一律 `plan` → `apply` 两步，`apply` 必须携带用户看到的那份计划的摘要；服务端重算摘要并比对，对不上就拒绝执行。**apply 路径本身也强制先重新 plan**，所以授权与摘要两道闸在 apply 上都拦得住。
- **已知且刻意接受的一处**：默认会自动打开浏览器，方式是把含 token 的 URL 作为参数传给系统的打开器（Windows `rundll32`、macOS `open`、Linux `xdg-open`）。进程命令行在部分系统上对同机其它进程可读，因此 token 的可见范围从"看得见终端的人"扩大到"能枚举进程的人"。**多用户机器上请用 `--no-open`**，自行把终端里那条 URL 贴进浏览器。
- **浏览器端把第三方内容只当文本。** 页面显示的几乎全部内容来自第三方 pack（名称、描述、路径、诊断），而本页持有能授权特权操作的 token。UI 源码禁用 `innerHTML` / `insertAdjacentHTML` / `document.write`，渲染全程 `textContent` / `createElement`，且由测试对源码做静态断言；恶意 pack 在名字里塞标记换不来脚本执行。
- **token 不离开本页。** 所有 UI 响应带 `Referrer-Policy: no-referrer`；pack 提供的 URL（homepage、仓库地址）渲染为纯文本，不是可点链接也不是图片地址；token 只存在于内存，不进 `localStorage` / `sessionStorage` / cookie。
- **样式是完全静态的。** 唯一的 `<style>` 块随 `index.html` 内置，无外部资源；UI 源码不得出现 `.style` 属性写入或 `setAttribute('style', …)`——持有 token 的页面上，动态 CSS 是与外链同族的外泄通道。
- **浏览器 bundle 是可审计的。** 零运行时依赖（不引 React / Vue / Vite），由仓内既有构建器打成约 36 kB 的单文件。这是刻意的设计约束：用户要审计"我点的那个授权开关到底做了什么"时，应该读得懂发给他的那份产物。
- **`composePreview` 是真正的只读操作。** 它只在私有临时目录中校验和组装；UI 接受本地目录、裸或固定 SHA 的 `github:`、GitHub 仓库 URL，以及带完整性信息的 `tarball:` 来源；裸 GitHub 输入会先解析为固定 SHA，preview、plan 与 provenance 只展示或保存该 pin。可导出 profile 的 `profile:` 来源仍被拒绝。测试对 `DSH_HOME` 做字节快照，任何目标写入都会失败。真正的 compose 安装仍复用 install 的 journal 事务和原有两步确认。
- **Skill 编辑没有浏览器可控路径。** 请求只能携带 `profile`、安全字符的 `skillId` 与内容；`/`、`\\`、`..` 一律拒绝，服务端自行 resolve `skills/<skillId>/SKILL.md`，并再次证明目录和文件仍在 skills 根内、且不是链接或特殊文件。内容超过 256 KiB 在 plan 前硬拒。编辑不会改写 pack 的 installed metadata，所以它永远是用户本地 drift，而不是伪造的 pack 归属。

## 失败后的机器状态

`install` 是带 journal 的事务。退出码区分两种结局，且这个区分本身是安全契约的一部分：

- **24**：装后验证失败但已**干净回滚**，机器状态等同安装前，重试安全。
- **25**：**需人工恢复**——回滚动作、journal 写入或锁释放失败，机器停在中间态。输出会给出精确的人工恢复路径。**在此状态下重试会在脏状态上二次写入。**

回滚**不删除**任何东西：新 profile 移入 `$DSH_HOME/.dshpack/backups/<txid>/`，`--replace` 的原 profile 原样 rename 回位。

## 开发与测试边界

自动化测试必须使用隔离的临时目录。除显式人工授权的合约 smoke test 外，不得启动 `dsh`，也不得读取或修改用户真实 `.dsh`、上游仓库或文档仓。

## 已知且刻意接受：本地 DNS 信任 opt-in

默认情况下，远程来源在连接前会拒绝 DNS 解析到私有或保留地址的主机名，以降低 SSRF 与 DNS
重绑定风险。`DSHPACK_TRUST_LOCAL_DNS=1` 是一项刻意的 opt-in：它只跳过这一条**主机名 DNS
结果**的地址分类预检，用于用户自己配置的 fake-IP 或透明代理——这些代理会把如
`codeload.github.com` 的真实远端映射到本地保留地址后再按其路由转发。

设置该变量即表示用户自行信任该 DNS 和代理路由；它不是对任意本地目标的放行。`localhost`、
`*.localhost` 以及所有 IP 字面量仍在 DNS 信任决定之前被拒绝，默认未设置该变量时原有预检
完全不变。

## GC managed-state boundary

- `dshpack gc` only collects generation manifests outside the retained/current set and CAS blocks
  unreferenced by every retained manifest. It refuses unsafe, special, hard-linked, replaced, or
  over-limit managed state before applying a collection plan.
- A GC transaction first quarantines candidate bytes in its journal backup so a failed transaction
  can roll them back. Only after commit does a separate lease-protected phase verify the recorded
  identity and SHA-256 again and purge that quarantine payload.
- When active-state collection has committed but physical reclamation cannot finish, GC reports a
  successful logical collection with `pendingPurge: true` and retains the sanitized state-failure
  code/reason. It never claims those quarantine bytes were physically reclaimed. The next non-dry
  GC run safely retries a still-verified committed GC quarantine; it never purges unrelated
  transaction backups.
- A durability or ownership ambiguity requiring manual recovery is never reported as a successful
  pending purge: it returns exit 25 with explicit recovery information.

## Legacy metadata migration boundary

- `dshpack migrate` reads a v0 marker and its recorded source but never rebuilds or writes the
  live profile. It first reconstructs the immutable base in a private scratch `DSH_HOME` with
  lifecycle scripts denied.
- The scratch subprocess environment is allowlisted. Credentials and inherited package-manager
  configuration are omitted; its cache, store, configuration, and temporary paths are scoped to
  the scratch home. This is isolation for migration work, not a claim of a complete sandbox.
- Migration requires immutable source/plugin commitments and a committed transaction-journal proof
  for the profile base. Missing or unsafe proof, unverified inputs, a rebuild requiring scripts,
  or a changed target fails closed without adopting live bytes as a new base.
- Private source or scratch cleanup that cannot be completed produces exit 25 with an explicit
  recovery path. If cleanup follows a committed migration, the report preserves the committed
  generation facts and marks the pending private cleanup rather than claiming rollback.
