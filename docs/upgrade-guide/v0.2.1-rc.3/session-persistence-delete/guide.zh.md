---
kind: upgrade-guide
description: "自定义 Session 持久化提供方必须实现具有写入排他保护的显式删除。"
---

# 为自定义 Session 持久化提供方实现删除

English | [中文](guide.md)

## 变更

`SessionPersistence` 新增抽象方法 `delete(id, options?)`。自定义提供方必须实现该方法；JSONL 提供方已提供实现。现有 Session 日志无需迁移。常规写入和格式升级仍保留已提交的各代文件；显式 Session 删除会移除所选 Session 的所有代文件。

## 迁移

1. 在每个自定义提供方中实现 `SessionPersistence.delete`。不存在时返回 `false`，删除提交后返回 `true`；有活动写入方时抛出 `SessionAlreadyOwnedError`。删除期间始终排除相同 id 的创建和写入打开操作。
2. 在修改前支持 `options.signal`，并在相同写入排他保护下比较传入的 `options.ifRevision`。修订不同时抛出 `SessionDeletionConflictError`。记录部分失败和断电保证，不要声称回滚。
3. 仅在删除提交后使用 Session id 触发 `session-persistence/deleted`。观察者失败不得将已提交的结果变成删除失败。
4. 根据更新后的[服务定义](../../../../packages/session/session-persistence/src/index.ts)编译提供方，然后测试不存在的 id、活动写入方、过期修订和提交后读取。成功删除后，`stat` 和 `list` 中不得再出现该 Session，也不得暴露较早的代文件。
