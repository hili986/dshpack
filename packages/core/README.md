# @dshpack/core

dshpack 的无副作用内核：pack / pack-lock 的契约定义、YAML 规范化、patch 计算与凭据扫描。

这是 [`dshpack`](https://www.npmjs.com/package/dshpack) CLI 的依赖包。除非你要自己读写 pack 格式，否则直接用 CLI 即可。

> **0.2.x 仍为预发布**，pack 格式尚未稳定。

## 契约来源

TypeBox 定义是唯一真源，`schemas/` 下的 JSON Schema 由它生成，并有漂移检查保证两者一致。想在别的语言里校验 pack，直接用这两份 schema：

```js
import packSchema from '@dshpack/core/schemas/pack.schema.json' with { type: 'json' };
import lockSchema from '@dshpack/core/schemas/pack-lock.schema.json' with { type: 'json' };
```

本包不做任何 I/O：不读文件、不发网络请求、不启动进程。所有落盘与执行都在 CLI 侧。

完整说明见仓库：<https://github.com/hili986/dshpack>

MIT
