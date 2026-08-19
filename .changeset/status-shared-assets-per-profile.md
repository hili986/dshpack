---
'dshpack': patch
'@dshpack/core': patch
---

`status` 的 `shared` 改为按 profile 去重计数

此前按资产出现次数累加，因此同一个 profile 里两份内容相同的资产会把自己标成 shared。这个数存在的意义是回答"卸掉这个 profile 会不会动到别的 profile 还需要的字节"，而自己的两份副本会随它一起被删——旧算法恰好在它要提示的那个动作上给出相反的答案。引用计数意义上的共享属于 `gc` 的账，不是 `status` 的。
