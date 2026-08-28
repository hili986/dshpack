---
"dshpack": patch
---

**M3.12：未知 license 的 preview/write 边界。** `dshpack compose --dry-run` 遇到 unknown/unlicensed source 时保留 `W_COMPOSE_UNKNOWN_LICENSE`，并以 exit 0 完成；实际 compose 写入仍须显式 `--allow-unknown-license` 才能越过 unknown-license 策略闸门。UI 在 preview 请求中不发送确认，只将显式确认用于 compose 写入的 plan/apply 流程；过期预览说明和来源选择/冲突的即时客户端反馈更清晰，服务端 preview 与 plan/apply 的判定仍为准。
