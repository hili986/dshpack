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
- 本工具只终止自己派生的进程；不做进程树终止（Windows 上那等同 `taskkill /T`，会误杀用户正在运行的 dsh）。
- **DSH_HOME 及其每一级祖先都不得是 symlink / junction / reparse point**，否则拒绝——链接可在校验与写入之间被换掉，使"路径在根内"的判断失效。判据是**逐级 `lstat`**，不是把路径字符串和 `realpath` 比：Windows 上 8.3 短名（`C:\Users\RUNNER~1\…`）和不同大小写拼法指向的是同一个目录、中间一个链接也没有，字符串却不相等。无法探查的祖先按"有链接"处理（fail closed）。

## 凭据处理

- `export` 在**收集前、写入前、写入后**各扫一次；命中即 exit 31 失败，**绝不"悄悄删除"**去制造一个看起来干净、实则不可审计的 pack。
- 诊断只输出 `path:line:column`，**绝不回显命中的值**（包括任何 ≥8 字符子串）。
- pack 目录里的仓库常规物（`README`、`LICENSE` 等）虽不部署，**仍然要过凭据扫描**。
- **已知且刻意接受的局限**：32/40 位十六进制串与 UUID 在非敏感键名下不被判为凭据，因为它们与本工具强制要求的 40 位 commit SHA、校验和及各类合法 id 完全同形，检测会让每个 pinned source 误报。残余暴露面因此可精确表述为：凭据须**同时**满足"存于非敏感键名下"且"形状与合法标识符碰撞"才可能漏。报告此类样本前请先确认它不属于该已知类别。

## 失败后的机器状态

`install` 是带 journal 的事务。退出码区分两种结局，且这个区分本身是安全契约的一部分：

- **24**：装后验证失败但已**干净回滚**，机器状态等同安装前，重试安全。
- **25**：**需人工恢复**——回滚动作、journal 写入或锁释放失败，机器停在中间态。输出会给出精确的人工恢复路径。**在此状态下重试会在脏状态上二次写入。**

回滚**不删除**任何东西：新 profile 移入 `$DSH_HOME/.dshpack/backups/<txid>/`，`--replace` 的原 profile 原样 rename 回位。

## 开发与测试边界

自动化测试必须使用隔离的临时目录。除显式人工授权的合约 smoke test 外，不得启动 `dsh`，也不得读取或修改用户真实 `.dsh`、上游仓库或文档仓。

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
