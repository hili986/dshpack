# Changesets

`dshpack` 使用 Changesets 记录用户可见的包变更。不要为纯测试、CI 或内部文档修正创建空 Changeset。

创建变更说明：

```sh
pnpm changeset
```

在交互提示中选择受影响的 workspace package、正确的 SemVer 级别，并用完整句子说明用户能观察到的变化。生成的 Markdown 文件应与实现和测试一起提交；不要手工编辑版本号或提前删除尚未发布的 Changeset。

SemVer 选择：

- `patch`：向后兼容的修复或小幅行为改进；
- `minor`：向后兼容的新能力；
- `major`：破坏性 API、CLI、schema 或行为变化。

发布 PR 会消费 Changeset 并更新版本与 changelog。在 M0 schema 尚未稳定时，也必须如实记录破坏性变化，不能用“尚未稳定”隐藏迁移影响。
