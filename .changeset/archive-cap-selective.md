---
"dshpack": patch
---

**大仓库可组合 + 预检上限可见（M3.8/M3.9）。**

### 修复

- 预检解压上限 12→256 MiB；超限以 `E_ARCHIVE_PREFLIGHT_CAP` 明示已解压字节数与上限，与真损坏的 `ARCHIVE_UNSAFE` 分诊；SECURITY 记数值。
- 组合页本地校验错误在输入变化时即时清除，不滞留到下次点击。
- GitHub API 限流改为明确诊断（`SOURCE_GITHUB_RESOLVE_RATE_LIMIT`）并提示固定 40 位 SHA 的绕过方式。

### 新增

- **compose 源选择性提取**：conventional skill 仓库只部署 `.agents/skills/<安全 id>/SKILL.md` 形路径；大二进制等非 skill 普通条目跳过不部署，`E_ARCHIVE_SELECTIVE_SKIPPED` 一次性报告跳过条目数与字节数；被跳过路径仍先过路径安全检查；`install` 的全量提取与全部上限一字不变。

### 安全

- 四条 mutant（M3.9）+ 一条选择性 id 规则独立钉（Claude 补：放宽 id 正则必须变红）。
