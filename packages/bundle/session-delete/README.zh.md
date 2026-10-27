---
description: "通过 GUI 和模型工具启用对未使用的已保存会话的永久删除。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-session-delete-bundle

[English](README.md) | 中文

## 概述

经人工确认后，永久删除已保存的会话，包括已加载和当前显示的会话。此可选 bundle 启用侧边栏删除操作及其 Host 服务；内置 profile 不会启用它。删除前会停止正在进行的工作，工作区文件保持不变。请先移除定时任务，再删除其所属会话。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

通过 profile 插件管理启用此 bundle。其 [patch](cordis.patch.yml) 添加 [删除服务](../../session/session-delete/README.zh.md) 和 [浏览器操作](../../client/ui-session-delete/README.zh.md)，不会替换现有 UI 包，也不会修改内置默认配置。

侧边栏会话菜单增加 **删除会话**，要求确认停止正在进行的工作以及不可撤销的删除。Host 会先释放已加载的会话，再删除其存储；权威移除通知会清除被删除的主会话选择。请先移除定时任务。工具和审批服务可用时，该服务也管理需要审批的模型工具；此工具无法删除调用它的会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

此 profile 层插入两个根条目：Host 服务对应 `optional-session-delete`，客户端插件对应 `optional-ui-session-delete`。两个包都是此 bundle 的生产依赖。工具注册由服务管理，因此此层不会添加各 preset 专用的工具条目。Bundle 入口本身没有运行时行为。

[服务](../../session/session-delete/README.zh.md) 管理删除安全和持久化效果；[客户端](../../client/ui-session-delete/README.zh.md) 管理确认框、本地化反馈和交互状态。禁用此层会移除这些插件贡献，不会删除先前保存的会话。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Profile 分层](../../../docs/architecture.zh.md) 介绍组合和覆盖。
- [会话删除服务](../../session/session-delete/README.zh.md) 介绍安全检查和工具行为。
- [会话删除 UI](../../client/ui-session-delete/README.zh.md) 介绍确认框和结果反馈。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过 [删除服务](../../session/session-delete/README.zh.md)，由其管理面向模型的删除工具和人工审批策略。

#### KV Cache 影响

Bundle 本身不添加提供商请求；服务管理面向模型的影响。

## 已知限制与待办工作
<a id="known-limitations-and-deferred-work"></a>

- 删除无法撤销；工作区文件不在删除范围内。
- 带有定时任务的会话会被拒绝删除。失败前已停止的工作不会自动恢复。
- Profile 安装和完整浏览器组合除组件和服务测试外，还需要集成验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
