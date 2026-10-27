---
description: "Permanently delete Sessions with owner-controlled shutdown, explicit confirmation, and human approval for agent calls. Sessions with reminders or lineage references are refused."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-delete

English | [中文](README.zh.md)

## Summary

Permanently delete a Session after confirming its exact identity, stopping its loaded Agent first when needed. Agent calls require a separate human approval for each deletion and cannot delete their own calling Session. Reminders and subagent or lineage relationships prevent deletion. This opt-in package is absent from shipped defaults and does not remove dependent resources.

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

Mount the service alongside `agents`, `sessions`, `sessionPersistence`, `sessionProjections`, and `schedule`. The package has no configuration fields and no Client entry. When `tools` and `approval` are present, it also contributes the global `session_delete` tool; no separate tool plugin is needed.

```yaml
- name: '@deepseek-ai/dsh-session-delete'
```

Human-facing callers use `ctx.sessionDelete.delete({ sessionId, confirmed: true })` only after confirming permanent deletion of that exact Session. The method never activates a cold Session. For a loaded Session, its creator stops the Agent, flushes final events, and releases ownership before deletion. Structured result codes distinguish deletion, absence, refusal, and failure; `failed` means the storage outcome is unverified, so refresh the stored-session listing before retrying. Deletion cannot be undone.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [service](src/index.ts) excludes concurrent activation through the Agent creator while checking live or durable metadata, reverse parent references, child catalogs, and reminder rows. A private host-only boolean projection tracks live child-reference events without retaining their history. Initial policy refusals do not stop the Agent. Shutdown runs outside the Schedule mutation queue so an in-flight schedule tool can settle. After release, a final Schedule guard and dependency check precede revision-checked physical deletion. Dependencies created during cancellation preserve the log but can leave the Agent stopped. Persistence owns the post-commit deletion notification.

The [tool](src/tool.ts) checks its calling Agent and requests a one-call grant through `approval.request`; a model-supplied confirmation cannot authorize deletion. Rejected, cancelled, or unavailable approvals leave storage untouched. Tool registration follows the service's Cordis lifetime and disappears on unload.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session persistence](../session-persistence/README.md) — ownership and deletion durability.
- [Schedule](../../schedule/schedule/README.md) — reminder rows and management.
- [User approval](../../interaction/user-approval/README.md) — fail-closed human decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema and result

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-session-delete) defines `session_delete`, which accepts `session_id` and `confirmed` and returns a compact JSON result containing the Session identity and result code. Its description begins: “Permanently delete one session after human approval, stopping it first if loaded or running. This cannot be undone.” Approval audit events belong to the calling Session; deletion does not rewrite its prior history. Generic tool presentation displays the request and result without a custom Client renderer.

#### Token effect

The optional tool schema and bounded result add tokens when available and invoked. Host-only calls add no model context.

#### KV Cache effect

Mounting or unmounting the tool changes the available schema context. Calls append ordinary tool history without replacing earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Deletion refuses fork-seeded Sessions, subagent Sessions, Sessions carrying child catalogs or descriptors, and stored parent-child references; dependent deletion is unsupported.
- Every stored reminder row blocks deletion, including ended reminders. Callers must explicitly delete those reminders first. A later explicit reminder creation for a deleted identity is outside this operation.
- The service deletes only Session persistence artifacts. Workspace metadata, projection caches, attachments, and external provider data are not cascaded.
- Human-facing service callers own confirmation. Only the agent tool enforces the interactive approval requirement.
- Loaded deletion requires creator-authorized release support; foreign owners and unsupported factories return `in-use`. Installed Hosts predating that capability retain cold-only deletion until restarted with a supporting core.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
