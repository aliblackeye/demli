# Regression List

Every fixed bug gets either an automated test or a permanent manual-checklist
entry. Newest first. Format: what broke, the fix, and where the regression
coverage lives.

| Fixed in | Bug | Coverage |
|---|---|---|
| `917bd5d` | Desktop `useAttachmentUrls` joined the ids key with `"\u0000"` but split it on `" "`, so any message with 2+ attachments requested one garbled NUL-joined id — multi-attachment tiles never resolved (single-attachment messages worked, which hid it). | Manual: "One message with 2+ attachments" item in `manual-checklist.md` §Attachments (BLOCKING). No automated hook-render rig exists in the desktop renderer (no jsdom/RTL); the underlying batching/chunking is pinned in `packages/client-core/src/__tests__/attachment-url-resolver.test.ts`. If a renderer test rig lands, promote this to an automated hook test. |
| M10-5 (pre-merge) | `sendMessagePayloadSchema` originally required `content.min(1)`, which would have rejected caption-less attachment sends. | Automated: `packages/protocol/src/__tests__/attachments.test.ts` ("attachment-only send with empty content"), `apps/api/src/__tests__/attachments.int.test.ts` ("allows an attachment-only message and rejects an empty one"), `apps/realtime/src/__tests__/gateway.int.test.ts` (caption-less broadcast test). |
