---
"douyin-im": minor
---

Add host adapter extension points: per-account `AccountOptions.imTransport` factories for the Cookie protobuf transport, `loginPolicy: 'saved-session-only'` with `SavedSessionRequiredError`, `loadContactsOnLogin`, and `account.frontierConnection`. `douyin-im/protocol` now exports the IM codec, `ImProtoTransport`, desktop request options and `pushFromResponse`, so adapters no longer need to patch shared prototypes or import internal files.
