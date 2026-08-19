# ADR-0004：子命令选项不得与 program 级选项撞名，且版本旗标错位必须被拒绝

- 状态：Accepted
- 日期：2026-08-19

## 背景

`dshpack init` 需要一个"设置 pack 版本号"的选项，最自然的拼法是 `--version`。
program 级同时注册了 `-V, --version` 输出工具自身版本。

Commander 默认在子命令**之后**仍然识别 program 级选项（官方文档：options are recognised
before and after subcommands）。于是 `dshpack init my-pack --version 0.1.0` 的实际行为是：
`--version` 被 **program** 消费，打印 `0.2.0`、退出 **0**、目录连建都没建。

0.2.0 带着这个缺陷发布了。更糟的是，`init` 在缺必填项时打印的那条"直接复制运行"的
命令里写的就是 `--version "0.1.0"`——**照着工具自己的建议敲，得到一个静默的空操作**。

### 为什么这一个比其它拼错严重得多

| 输入 | 结果 |
|---|---|
| `init X --bogus 1 …` | `error: unknown option '--bogus'` / **rc=2** |
| `init X --version 9.9.9 …` | 打印 `0.2.0` / **rc=0** / 目录未创建 |

任何**别的**拼错都报错。唯独撞名这一种**假装成功**：包在外面的脚本读到 rc=0，
于是把根本不存在的产物往下游传。

**一个命令行工具的错误路径可以不完美，但绝不能有"成功地什么都没做"这一档。**

### 为什么 1945 条测试全绿还能漏

两类测试都在，只是没有一条同时跨过它们：

- 断言那条提示语的单测构造的是 `new Command().option('--json')`——**不带 `.version()` 的
  裸 program**，撞名在它里面结构上不可能出现。
- 用真实 `createProgram()` 的边界测试测过 `-V` / `--version` / `--version --json`，
  但**从没把版本旗标放到子命令之后**。

一侧有真实 program 却没有那个 argv 形状，另一侧有那个形状却没有真实 program。

## 决策

1. **子命令选项名不得与 program 级选项相同**（`--dsh-home` / `--no-color` / `--quiet` /
   `--json` / `-V, --version`）。语义确实需要时改名并加前缀——pack 版本号用
   **`--pack-version`**。这是 review 的必查项。

2. **版本旗标出现在子命令之后 ⇒ 拒绝**：`E_USAGE` / exit 2，提示按子命令定制
   （`init` 指向 `--pack-version`，其余指向"把 `--version` 放到子命令之前"）。
   守卫在 `runCli` 里于 parse **之前**执行，覆盖所有子命令。

3. **守卫扫描 argv 时必须尊重 `--` 终止符**，其后是操作数而非旗标。

4. **工具打印给用户复制的每一条命令，必须有一条测试把它抓出来照原样执行，
   并断言产物**（不是只断言退出码）。

### 为什么不用 `enablePositionalOptions()`

它是 Commander 官方一次性关掉整类撞名的开关，代价是 program 级选项在子命令之后不再被
识别。而 `--dsh-home` 正是这个形状，且是**我们自己产出的命令**在用：

- `README.md` 快速上手：`install --dry-run --as demo --dsh-home <隔离目录> -- <pack-dir>`
- `install/policy.ts` 生成的机器 argv：`['install', '--as', …, '--dsh-home', …]`
- `install-plan-review.test.ts` 断言 `nonInteractiveCommand` 含 `--dsh-home '`

启用它会**打断工具让人复制、让自动化执行的那条 install 命令**。用窄守卫换掉一个全局
开关，是因为这个全局开关会破坏一个已文档化的契约。

### 已登记的技术债

更彻底的解法是把 `--dsh-home` 下放到每个子命令，然后启用 `enablePositionalOptions()`。
那要动 `resolveDshHome(program)` 与全部命令，属架构级改动，不该塞进一个补丁版。
**若将来再出现第二例 program／子命令撞名，就是该做这次重构的信号。**

## 对贡献者的规则

- 新增子命令选项时，先对照 program 级选项清单。撞名时 **program 永远赢，而且是静默的**。
- 新增子命令时**只需**把它加进 `cli.ts` 的 `commandDefinitions`——`COMMAND_NAMES` 由它派生，
  守卫自动覆盖。**不要**手写第二份命令名清单。
- 守卫故意**不解析选项元数**（不知道每个选项吃几个值）。重新实现一遍 Commander 的解析器
  是更脆的选择。残留的不精确是：某个选项**值**恰好拼成子命令名时扫描会提前开始
  （`--dsh-home list --version`）。它偏向**带清晰提示地拒绝**，绝不偏向本 ADR 要根除的
  静默 exit 0，所以不要"修"它。

## 后果

**收益**：撞名从"静默成功"变成"明确拒绝"；保护范围是所有子命令，不只是 `init`。
自指的 e2e 钉子不硬编码旗标名，将来拼写再变仍在测唯一要紧的事。

**代价**：

- `dshpack list --version` 这类原本会打印工具版本的写法现在报错。这是有意的——
  它本就是歧义输入，明确拒绝比返回一个可能不是用户想要的东西更好。
- 守卫在 parse 前多扫一遍 argv。相对于进程启动可以忽略。
- 上面那条已登记的技术债：真正的命名空间隔离尚未做，只是把最危险的一种形态挡住了。
