---
title: Superserve
description: Track the Superserve sandbox connector recipe and its current availability status.
lastReviewedAt: 2026-06-12
---

Superserve previously had a sandbox connector entry in the Flue connector catalog, intended to adapt an initialized Superserve sandbox into Flue's sandbox interface.

## Current availability

The Superserve recipe has been temporarily removed from the `flue add` catalog: it targeted an older connector surface (a removed `@flue/sdk/sandbox` import and a cleanup callback that `createSandboxSessionEnv(...)` no longer accepts) and would not type-check against the current runtime. Restoration is tracked in the Flue repository's issue tracker.

| Intended requirement | Value                    |
| -------------------- | ------------------------ |
| Provider package     | `@superserve/sdk`        |
| Credential           | `SUPERSERVE_API_KEY`     |
| Intended environment | Provider-managed sandbox |

In the meantime, choose another available sandbox connector or implement a project-owned adapter against the public [Sandbox Connector API](/docs/api/sandbox-api/).

See [Sandboxes](/docs/guide/sandboxes/) and [Sandbox Connector API](/docs/api/sandbox-api/).
