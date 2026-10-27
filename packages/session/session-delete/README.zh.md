---
description: "通过所有者控制的关闭、明确确认和 Agent 调用的人工批准永久删除 Session。存在提醒或谱系引用的 Session 会被拒绝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-delete

[English](README.md) | 中文

## 概述

确认确切身份后永久删除 Session，必要时先停止其已加载的 Agent。每次 Agent 删除调用都需要单独的人工批准，且不能删除调用自身的 Session。提醒以及子 Agent 或谱系关系会阻止删除。此可选包不包含在随附默认配置中，也不会删除依赖资源。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

与 `agents`、`sessions`、`sessionPersistence`、`sessionProjections` 和 `schedule` 一起挂载该服务。此包没有配置字段，也没有 Client 入口。当 `tools` 和 `approval` 存在时，它还会提供全局 `session_delete` 工具，无需单独的工具插件。

```yaml
- name: '@deepseek-ai/dsh-session-delete'
```

面向用户的调用方仅在确认永久删除该确切 Session 后，才调用 `ctx.sessionDelete.delete({ sessionId, confirmed: true })`。该方法不会激活冷 Session。对于已加载的 Session，其创建者会先停止 Agent、持久化最终事件并释放所有权，然后再删除。结构化结果代码区分删除、缺失、拒绝和失败；`failed` 表示存储结果未验证，因此重试前应刷新已存储 Session 列表。删除无法撤销。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部机制——点击展开</summary>

[服务](src/index.ts) 通过 Agent 创建者排除并发激活，同时检查实时或持久化元数据、反向父级引用、子级目录和提醒行。私有的仅 Host 布尔投影跟踪实时子级引用事件，不保留其历史。初始策略拒绝不会停止 Agent。关闭在 Schedule 变更队列之外运行，使进行中的提醒工具可以完成。释放后，最终 Schedule 保护和依赖检查先于带修订检查的物理删除。取消期间创建的依赖会保留日志，但可能让 Agent 保持停止状态。持久化负责提交后的删除通知。

[工具](src/tool.ts) 检查调用它的 Agent，并通过 `approval.request` 请求单次授权；模型提供的确认不能授权删除。拒绝、取消或不可用的批准都不会更改存储。工具注册遵循服务的 Cordis 生命周期，并在卸载时移除。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Session 持久化](../session-persistence/README.zh.md)——所有权和删除持久性。
- [Schedule](../../schedule/schedule/README.zh.md)——提醒行和管理。
- [用户批准](../../interaction/user-approval/README.zh.md)——默认拒绝的人工决策。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 Schema 与结果

#### 模型看到的内容

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-session-delete)定义了 `session_delete`，它接受 `session_id` 和 `confirmed`，并返回包含 Session 身份和结果代码的紧凑 JSON 结果。其描述开头为：“Permanently delete one session after human approval, stopping it first if loaded or running. This cannot be undone.” 批准审计事件属于调用 Session；删除不会重写其先前历史。通用工具展示显示请求和结果，无需自定义 Client 渲染器。

#### Token 影响

可选工具 Schema 和有界结果在工具可用且被调用时增加 Token。仅 Host 调用不会增加模型上下文。

#### KV Cache 影响

挂载或卸载工具会改变可用的 Schema 上下文。调用追加普通工具历史，不替换早期消息。

## 已知限制与待完成工作

<a id="known-limitations-and-deferred-work"></a>

- 删除拒绝具有分叉种子的 Session、子 Agent Session、带有子级目录或描述符的 Session，以及已存储的父子引用；不支持依赖删除。
- 每个已存储的提醒行都会阻止删除，包括已结束的提醒。调用方必须先明确删除这些提醒。之后为已删除身份明确创建提醒不属于本操作的范围。
- 服务仅删除 Session 持久化产物。工作区元数据、投影缓存、附件和外部提供方数据不会级联删除。
- 面向用户的服务调用方负责确认。只有 Agent 工具强制执行交互式批准要求。
- 删除已加载 Session 需要创建者授权的释放支持；外部所有者和不支持的工厂返回 `in-use`。缺少此能力的已安装 Host 在以支持该能力的核心重启前仍然只支持冷删除。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
