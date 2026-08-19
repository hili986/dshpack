# compose 示例：两个来源撞同名

跑一遍：

```bash
dshpack compose examples/compose/compose.yml --output /tmp/notes-kit
```

产出 `pack.yml` + `pack.lock.yml` + `skills/note-taking/SKILL.md` + `patch/cordis.patch.yml`，并打印一条 `W_COMPOSE_PREFER` 说明选了哪个来源、未选中的不进产出。

**这个示例存在的意义是第二种跑法**。把 `compose.yml` 里的 `resolve` 块删掉再跑：

```
E_COMPOSE_CONFLICT  skill note-taking 存在多个来源: ./sources/team-notes, ./sources/personal-notes
```

退出码 30，零产出。两个来源都提供 id 为 `note-taking` 的 skill，`compose` **不替你猜**——因为"后写的 include 覆盖先写的"会让 pack 的内容取决于书写顺序，而作者不会注意到自己丢了东西。要么 `prefer` 挑一个，要么 `rename` 改名让两个都留下。

`scripts/validate-example-compose.mjs` 在 CI 里把上面两条都跑一遍：既验它能组装，也验**去掉 `resolve` 后确实被 30 拒绝**。只验前者的话，这个示例哪天退化成"其实没有冲突"也照样绿，而它要演示的东西已经悄悄没了。
