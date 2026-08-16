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

在任何安装写入或获准的 build script 执行之前，最终实现必须先生成一份可审计的 “Will install” 计划。计划至少列出：

- pack、插件和 preset 的名称、来源、精确版本或不可变 revision；
- 每个远程工件的 SRI；
- 将创建、覆盖或保留的目标路径；
- 将执行的 subprocess/build script 以及对应的 `allowBuilds` 授权；
- 插件变更后必须启动新的 DSH 进程这一事实。

实际输入、下载内容或写入集合与计划不一致时必须中止并重新生成计划。M0 尚未实现安装流程；在上述约束落地并有测试覆盖前，不应把占位命令用于真实配置。

## 开发与测试边界

自动化测试必须使用隔离的临时目录。除显式人工授权的合约 smoke test 外，不得启动 `dsh`，也不得读取或修改用户真实 `.dsh`、上游仓库或文档仓。
