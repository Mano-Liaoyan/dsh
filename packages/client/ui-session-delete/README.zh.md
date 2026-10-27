---
description: "为未使用的已保存会话添加可选的永久删除操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-delete

[English](README.md) | 中文

## 概述

在侧边栏会话行菜单中明确确认后，删除已保存的会话，包括当前显示的会话。Host 会在删除前停止正在进行的工作。确认框说明工作区文件会保留，且删除无法撤销。请先移除定时任务，再删除其所属会话。可选的 [会话删除 bundle](../../bundle/session-delete/README.zh.md) 将此操作与 Host 服务一并启用。

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

通过 profile 插件管理启用 [会话删除 bundle](../../bundle/session-delete/README.zh.md)，将此浏览器操作与删除服务组合。此插件没有配置字段，且不会在内置默认配置中启用。

打开会话行菜单并选择 **删除会话**。**取消** 保持会话不变；**永久删除** 发送已确认的请求。删除进行期间，对话框保持打开，并忽略重复确认、Escape 和关闭操作。操作结束后，shell 级 Toast 显示成功、拒绝或结果未确认的反馈。

Host 会先停止并释放已加载的会话，再将其删除；请先移除该会话的定时任务。权威移除通知通过 Workspace 导航 owner 清除当前显示的会话。此操作不会乐观移除会话行。传输错误会提示结果未确认：重试前请检查会话列表。失败前已停止的工作不会自动恢复。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

浏览器在 `sidebar.workspaces.session.menu.item` 注册一个破坏性操作项，并在 `shell.overlay` 注册一个条目。插件自有的交互 store 在菜单卸载后保留确认框和 Toast 状态。Slot 声明生命周期管理两个注册，卸载插件会移除它们。

生成的 `sessionDelete.delete` remote 接收选中的带品牌 Session id 和 `confirmed: true`。[删除服务](../../session/session-delete/README.zh.md) 负责安全检查和提交删除；此包不修改 Session 或 Workspace 模型。类型化的英文和简体中文词典管理所有 UI 文案，其他语言使用 locale 服务的英文回退。现有 MenuItemButton、Modal、Button、Toast 和垃圾桶图标提供控件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [会话行扩展](../ui-workspace/README.zh.md) 介绍菜单归属和排序。
- [会话删除 bundle](../../bundle/session-delete/README.zh.md) 管理可选组合。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此浏览器操作不注册面向模型的工具或提示内容。

#### KV Cache 影响

无；此浏览器操作不组装或发送模型请求。

## 已知限制与待办工作
<a id="known-limitations-and-deferred-work"></a>

- 删除无法撤销，工作区文件不在删除范围内。
- 删除操作可能先停止工作，然后才失败；已停止的工作不会自动恢复。
- UI 等待权威目录更新，不会在本地移除会话行。
- 完整浏览器组合除包内定向 UI 测试外，还需要集成验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
