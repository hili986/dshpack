# Changelog

## 0.1.1

第一个从 npm 装回来跑出的补丁。0.1.0 的流水线全绿，但把它装进隔离前缀、用**装出来的二进制**跑一遍，一次暴露五个缺陷——全都不在测试的射程内。

### 修复

- **`--version` 补上。** 0.1.0 完全没有注册这个 flag（`error: unknown option '--version'`）。现在 `dshpack --version` / `-V` 输出版本号，`--version --json` 把它放在 `version` 键下而不是塞进 `help` 文本。
- **`generatedBy` 不再是 `dshpack@0.0.0`。** 版本字面量原先在 lock、export、install 三处各写一遍，其中 install 那份从未更新，于是**每一次安装写进 `.dshpack/installed/<profile>.json` 的审计记录都标着 0.0.0**。三处统一到唯一来源 `src/version.ts`，并加了一条测试扫描源码拒绝任何 `dshpack@<数字>` 字面量。
- **`list` 不再误报。** 三处修正：
  - `profiles/node_modules` 是 dsh 启动器维护的扁平模块回退目录（dsh 自己在 `resolveProfileDir` 里直接拒绝这个名字），不再被当成 profile；
  - 非 profile 的目录与散落文件不再被枚举打分——判据改用 dsh 自己的那一条：**目录里有没有 `package.json`**；
  - `web` / `headless` 是 dsh 自带的保留 profile，健康得很，只是 dshpack 不接管。它们原先被"能不能作为安装目标"的命名规则判成 `broken 名称不符合安全规则`，现在是新状态 **`reserved`**。`broken` 一词只留给真正损坏的。

  被 dshpack 记录过、但目录已经不再是 profile 的情况**仍然报 broken**；`profiles/` 下的 junction 也**仍然报出来**，不会因为"看起来没有 manifest"被静默跳过。
- **`switch` 接受保留名。** 同一条错误规则也卡着 `dshpack switch web`——而 switch 只是校验并打印启动命令，不接管任何东西。
- **`homepage` / `bugs.url` 填的是真地址。** 0.1.0 两个包发布时都还是模板占位符 `https://github.com/<owner>/<repo>#readme`。
- **两个包都带上 README。** 0.1.0 的 npm 落地页是空白的。
- **移除死依赖 `validate-npm-package-name`。** 它从未被 import，却是唯一与声明的 `engines` 冲突的运行时依赖（要求 `^22.22.2 || ^24.15.0 || >=26.0.0`），害得每个用户装包时看到 EBADENGINE 警告。移除后 `>=22.19.0 <25` 与整个 47 个包的运行时依赖闭包完全自洽。

### 门禁增强

- release gate 增加**占位符 URL 拒绝**：原先只检查 `homepage` / `bugs` 是否*存在*，模板值堂堂正正通过了必填检查。
- release gate 增加 **tarball 必须含 README** 的检查。

### 兼容性

`list --json` 的 `status` 新增取值 `reserved`。原先落在 `broken` 里的保留名 profile 会改报 `reserved`，非 profile 目录不再出现在结果中。其余输出不变。

## 0.1.0

首次发布。`install` / `export` / `list` / `validate` / `doctor` / `lock` / `switch`，带回滚快照、凭据三重扫描与 npm provenance。`init` 与 `pack` 两个作者向命令尚未实现。
