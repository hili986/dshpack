---
'dshpack': minor
---

**新增 `dshpack compose [compose.yml]`：按一份声明式清单，把多个来源的 skill 组装成一个新 pack。**

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
