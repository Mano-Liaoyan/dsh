---
kind: upgrade-guide
description: "Custom Session persistence providers must implement explicit deletion with writer exclusion."
---

# Implement deletion in custom Session persistence providers

English | [中文](guide.zh.md)

## Change

`SessionPersistence` adds the abstract `delete(id, options?)` method. Custom providers must implement it; the JSONL provider supplies it. Existing Session logs need no migration. Normal writes and format upgrades still preserve committed generations; explicit Session deletion removes every generation of the selected Session.

## Migration

1. Implement `SessionPersistence.delete` in each custom provider. Return `false` when absent and `true` after committed deletion; refuse an active writer with `SessionAlreadyOwnedError`. Keep same-id create and write-open excluded throughout deletion.
2. Support `options.signal` before mutation and compare `options.ifRevision`, when supplied, under the same writer exclusion. Reject a changed revision with `SessionDeletionConflictError`. Document partial-failure and power-loss guarantees rather than claiming rollback.
3. Emit `session-persistence/deleted` with the Session id only after committed deletion. Observer failures must not turn that committed result into a deletion failure.
4. Compile the provider against the updated [service definition](../../../../packages/session/session-persistence/src/index.ts), then test missing ids, active writers, stale revisions, and post-commit reads. Successful deletion must disappear from `stat` and `list` and must not expose an older generation.
