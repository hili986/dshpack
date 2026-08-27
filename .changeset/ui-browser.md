---
"dshpack": minor
---

**M2：Pack 管理有了浏览器界面。** `dshpack ui` 从 M2-A 的服务端骨架长成了完整界面——这是"看"与"做"两条线同时落地的一次发版。

### 新增

- **`dshpack ui` 浏览器界面**——总览（每个 profile 的 tracked/untracked/reserved/broken、代际、漂移、共享、更新状态）、单 profile 的 diff（本地漂移 / 上游差量 / 生效不一致，逐资产 digest）、诊断（逐条 `path:line:column` + 副作用归属）、pack 详情（manifest / provenance / lock）四个只读视图；`install` / `uninstall` / `update` / `restore` / `gc` 五个写操作共用一条 **plan → 逐项授权审阅 → apply** 流程。

  安全模型是这次的重点，逐条钉死：**界面不能成为比 CLI 更松的授权路径**。每项危险授权是独立开关且默认全关；不存在"全部同意"；计划摘要变化（或 apply 收到 409）后已授权项清空、必须重新审阅；403 只高亮缺项、不自动补授权重放；执行按钮在授权不齐时直接 disabled。判定全在服务端，"前端不会那么发"不是理由。

- **零运行时依赖的前端**——不引 React / Vue / Vite，TypeScript + DOM 直写，构建产物是约 36 kB 的单文件。这是刻意的：这个界面是危险授权的确认界面，用户想审计"我点的那个开关到底做了什么"时应该读得懂发给他的那份产物。状态机是纯函数、渲染走描述树、落到 DOM 只有 `textContent` / `createElement`；第三方 pack 的任何字段都只当文本显示。

- **token 不离开本页**——所有 UI 响应带 `Referrer-Policy: no-referrer`；静态资源与页面一样过 token 闸；pack 提供的 URL 渲染为纯文本而非链接；样式是唯一的内联静态 `<style>`，无任何动态 CSS 通道。浏览器产物落进发布包（`dist/ui/`），tarball 断言 + 装回探针双保险。

### 修复

- **gc 引擎的覆盖率门槛脆性**——ubuntu CI 曾因 `gc/engine.ts` 分支 89.86% 贴线变红。修法不是降门槛：补了三条真测试（锁内重扫的非预期错误原样上抛、adapter 中止的带诊断/无诊断两侧映射），抬到 91.81%，每条各带 mutant 红绿证据。

### 其他

- `packages/ui` 四个源文件进入逐文件 90% 分支门槛清单。
- 发布后验证程序新增第 ⑬ 步：从 registry 装回来的二进制必须能真起 UI、token 双向拒绝、`Referrer-Policy` 在场、bundle 非空。
