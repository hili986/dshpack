---
"dshpack": minor
---

**贴 GitHub 网址就能装 + 代理网络 opt-in（M3.5）。** 用户裁决：功能性第一；安全机制不得让核心流程在用户网络环境里不可用。

### 新增

- **裸 GitHub 来源自动解析**：`https://github.com/owner/repo`（容忍尾斜杠/`.git`）与 `github:owner/repo`（无 SHA）现在被接受；服务端把默认分支 HEAD 解析成 40 位小写 SHA 后**钉死**——计划/预览展示解析出的 SHA，lock/provenance 记 SHA，确认窗口内 re-plan/apply 用冻结的 pin（防 HEAD 在审阅期间移动的 TOCTOU）。带 `#sha` 的既有形态一字不变。
- **`DSHPACK_TRUST_LOCAL_DNS=1` opt-in**：fake-ip/透明代理会把 github 主机解析到保留地址段， SSRF 预检默认拒绝这类回答。设置该变量后跳过"本地 DNS 回答为私有/保留段"的预检（`localhost`、`*.localhost`、IP 字面量**仍拒绝**）；默认行为一字不变。SECURITY.md「已知且刻意接受」节与 README 均写明语义与代价。

### 安全

- 三条 mutant 红绿证据：未设 opt-in 也跳过预检 → 红；自动解析不钉 SHA → 红；opt-in 下 localhost 拒绝被跳过 → 红。
- 失败保留分类：解析期的网络/仓库/限流错误仍走 exit 20 族诊断，不降级为通用契约码。
