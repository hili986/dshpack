---
"dshpack": patch
---

**浏览器端诊断不再谎报 DSH003。** UI doctor 本就不启动 dsh 子进程（只读面），此前却走 catch 分支显示"无法在 5 秒内执行 dsh --version"，把设计行为伪装成宿主故障。现以 `skipDshHost` 显式跳过宿主探针并给出 info 级如实诊断"浏览器端诊断为只读，跳过 dsh 宿主探针；命令行运行 dshpack doctor 获取宿主结论"；本地只读检查（patch/skill/凭据）保留；rejecting runner 留作纵深背底。
