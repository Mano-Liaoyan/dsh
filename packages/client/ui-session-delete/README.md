---
description: "Add an optional permanent deletion action for inactive saved sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-delete

English | [中文](README.zh.md)

## Summary

Delete saved sessions, including the currently displayed session, from their sidebar row menu after explicit confirmation. The Host stops running work before deletion. The confirmation explains that workspace files remain and that deletion cannot be undone. Remove scheduled tasks before deleting their session. The optional [Session deletion bundle](../../bundle/session-delete/README.md) enables this action together with its Host service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the [Session deletion bundle](../../bundle/session-delete/README.md) through profile plugin management to compose this browser action with the deletion service. This plugin has no configuration fields and is not enabled in shipped defaults.

Open a session row’s menu and select **Delete session**. **Cancel** leaves the session unchanged; **Delete permanently** sends the confirmed request. The dialog remains open while deletion is pending and ignores repeated confirmation, Escape, and dismissal. A shell-level Toast reports success, refusal, or an unconfirmed outcome after the operation settles.

The Host stops and releases a loaded session before deleting it; remove its scheduled tasks first. Authoritative removal clears the displayed session through the Workspace navigation owner. The action never removes a row optimistically. Transport errors report an unconfirmed outcome: inspect the session list before retrying. Work already stopped before a failure is not resumed automatically.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser registers one destructive entry in `sidebar.workspaces.session.menu.item` and one `shell.overlay` entry. A plugin-owned interaction store keeps confirmation and Toast state alive when the menu unmounts. Slot declaration lifetimes own both registrations, and disposing the plugin removes them.

The generated `sessionDelete.delete` remote receives the selected branded Session id and `confirmed: true`. The [deletion service](../../session/session-delete/README.md) owns safety checks and committed deletion; this package does not mutate Session or Workspace models. Typed English and Simplified Chinese dictionaries own all UI copy, with the locale service’s English fallback for other languages. Existing MenuItemButton, Modal, Button, Toast, and trash artwork provide the controls.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session row extensions](../ui-workspace/README.md) describe menu ownership and ordering.
- [Session deletion bundle](../../bundle/session-delete/README.md) owns opt-in composition.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser action registers no model-facing tools or prompt content.

#### KV Cache effect

None; this browser action neither assembles nor sends model requests.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Deletion cannot be undone, and workspace files are outside its scope.
- Deletion may stop work before a later failure; stopped work is not resumed automatically.
- The UI waits for authoritative catalog updates rather than removing rows locally.
- Full browser composition requires integration verification in addition to the package’s focused UI tests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
