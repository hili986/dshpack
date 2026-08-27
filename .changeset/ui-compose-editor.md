---
"dshpack": minor
---

**浏览器界面支持自由组合与 Skill 编辑（M3）。** 用户裁决：写操作保留两步确认；"在界面里直接操作、自由组合"从 CLI 专属搬进 UI。

### 新增

- **自由组合页**：增量添加来源（本地目录 / 固定 SHA 的 `github:` / 带完整性的 `tarball:`），预览逐来源可选 skill、provenance 与全量冲突（`composePreview` 严格只读，私有临时目录内组装，`DSH_HOME` 零写入）；冲突必须单选 `prefer`（可选来源）或 `rename` 后，才经既有 plan → 逐项授权 → apply 组装并安装为新 profile（复用 install 的 journal 事务）。
- **Skill 编辑器**：profile 的 skill 列表标出已有 drift；等宽 textarea 属性装载原文；浏览器只提交 `profile` + 安全字符 `skillId` + 文本，服务端自行闭合到 `skills/<skillId>/SKILL.md`（白名单 + resolve 双重防护），256 KiB 硬上限；保存不重写 installed metadata，永远是你自己的 drift。

### 安全

- 五条新闭合项各带 mutant 红绿证据：skillId 放行 `..`、resolve 根目录越界、preview 写 `DSH_HOME`、textarea 改 innerHTML、保存内容伪造 pack 归属——全部变红后还原。
- SECURITY.md 增补 `composePreview` 只读边界与 Skill 编辑路径闭合两条。
