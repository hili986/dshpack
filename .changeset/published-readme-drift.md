---
'dshpack': patch
'@dshpack/core': patch
---

修正发布到 npm 上的 README：它仍称 `init` / `pack` 未实现，且只列了 17 个命令中的 7 个

仓库根 README 早已更新，但 npmjs.com 上展示的是 `packages/*/README.md`，两者之间没有任何东西连着——于是"工具是对的、对工具的描述是错的"这类缺陷不会被任何行为测试抓到。同时把根 README 里另外两处同样过期的断言（开篇横幅、故障排查条目）一并修掉。

新增 `verify:readme-commands` 门禁：CLI 注册的每个命令必须在两份 README 里各被提及一次、任一 README 不得称已发布命令未实现、预发布说明必须写当前版本序列。
