/**
 * App-wide signed-URL resolver singleton (ADR 0008 §5), wired to the shared
 * batching cache in @demli/client-core and the mobile HTTP client.
 */

import { createAttachmentUrlResolver } from "@demli/client-core";
import { getApi } from "../clients";

export const attachmentUrlResolver = createAttachmentUrlResolver({
  fetchUrls: async (channelId, attachmentIds) =>
    (await getApi().getAttachmentUrls(channelId, attachmentIds)).urls,
});
