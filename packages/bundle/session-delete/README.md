---
description: "Enable permanent deletion of inactive saved sessions through the GUI and agent tools."
kind: "package-bundle"
---

# @deepseek-ai/dsh-session-delete-bundle

English | [中文](README.zh.md)

## Summary

Permanently delete saved sessions after human confirmation, including loaded and currently displayed sessions. This opt-in bundle enables the sidebar deletion action and its Host service; shipped profiles do not enable it. Running work stops before deletion, while workspace files remain untouched. Remove scheduled tasks before deleting their session.

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

Enable this bundle through profile plugin management. Its [patch](cordis.patch.yml) adds the [deletion service](../../session/session-delete/README.md) and [browser action](../../client/ui-session-delete/README.md) without replacing existing UI packages or modifying shipped defaults.

The sidebar session menu gains **Delete session**, which confirms both stopping running work and irreversible deletion. The Host releases loaded sessions before deleting their storage; authoritative removal clears a deleted main selection. Scheduled tasks must be removed first. The service also owns the approval-gated model tool when tool and approval services are available; that tool cannot delete its calling session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The profile layer inserts two root rows: `optional-session-delete` for the Host service and `optional-ui-session-delete` for the client plugin. Both packages are production dependencies of this bundle. Tool registration belongs to the service, so this layer adds no preset-specific tool rows. The bundle entry itself has no runtime behavior.

The [service](../../session/session-delete/README.md) owns deletion safety and durable effects; the [client](../../client/ui-session-delete/README.md) owns confirmation, localized feedback, and interaction state. Disabling the layer removes these plugin contributions, not previously saved sessions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Profile layers](../../../docs/architecture.md) explain composition and overrides.
- [Session deletion service](../../session/session-delete/README.md) documents safety checks and tool behavior.
- [Session deletion UI](../../client/ui-session-delete/README.md) documents confirmation and outcome feedback.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [deletion service](../../session/session-delete/README.md), which owns the model-facing deletion tool and human approval policy.

#### KV Cache effect

The bundle adds no provider requests itself; the service owns any model-facing effect.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Deletion cannot be undone; workspace files remain outside its scope.
- Sessions with scheduled tasks are refused. Work stopped before a later failure is not resumed automatically.
- Profile installation and full browser composition require integration verification beyond the component and service suites.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
