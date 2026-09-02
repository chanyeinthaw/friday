# Linked Discord channels

Friday can hand an exact Discord source conversation to an operator channel. Both endpoints may use different configured Discord bot connections and different guilds.

## Configure a link

```text
friday config discord link set <id> \
  <source-connection> <source-guild> <source-conversation> <channel|thread> \
  <destination-connection> <destination-guild> <destination-channel> channel

friday config discord link get <id> [--json]
friday config discord link list [--json]
friday config discord link enable <id>
friday config discord link disable <id>
friday config discord link remove <id> --yes
```

`set` fully replaces the link. It does not patch one endpoint. Link changes take effect after `friday config reload`. A connection added after Friday started still needs a restart before a link can use it.

Friday rejects malformed snowflakes, duplicate sources, exact self-links, thread destinations, missing or non-Discord connections, and disabled or unconfigured guilds. In v1 the destination must be a channel because Friday creates the operator thread inside it. The source may be an exact channel or thread. Both bots need access to their configured endpoint. The source bot needs message history and reaction permissions. The destination bot needs thread creation and message permissions.

## Exact matching and admission

A link matches the source connection, guild, and exact incoming conversation ID. A parent channel does not include its child threads. A linked thread does not include its parent.

Linked handoff still applies the normal guild, channel, and user admission policy. A channel source uses its own channel policy. A thread source uses its observed parent-channel policy while matching and posting to the exact thread ID. Friday records that parent channel in immutable provenance. If Discord cannot provide a parent for an exact linked thread, Friday fails closed. A linked message must contain an actual Friday mention, even when the channel invocation mode is `all-messages`. A linked message without a mention is ignored. Once an eligible linked mention is accepted, Friday does not create a source thread, send a source text response, or fall back to normal routing if handoff fails.

## Handoff

Friday adds 👀 while a handoff is in progress. It fetches the triggering message directly by ID, then bounded prior history anchored before it. The generated assignment receives opaque participant aliases and source content, including authoritative ISO source and reply timestamps when Discord supplies them, reply context, and attachment names, metadata, and URLs. It does not receive Discord participant IDs, native mention tokens, or the authoritative source URL. Friday does not download source attachments or add them as Pi image attachments.

A text-generation pass creates a schema-decoded title and initial prompt. The model receives source content as untrusted participant material and must preserve facts, constraints, links, unresolved questions, and attribution without inventing requirements or authority. Friday rejects generated text that uses its reserved provenance markers. It then appends a clearly framed Friday-owned block containing the source URL and participant IDs from structured Discord data. Generated text is never used to resolve an ID.

Friday creates a standalone destination thread, posts a compact source header with mentions suppressed, persists immutable source provenance on the ChannelThread, and dispatches the generated prompt through the normal channel-agent turn lifecycle. The full source transcript is not posted in the visible header.

Friday acquires the source connection capability before claiming the message. After prompt generation, thread creation, starter publication, and initial turn dispatch all succeed, Friday removes 👀 and adds ✅. Once that capability is available, any required-stage failure, including the initial deduplication claim, independently attempts to remove 👀 and add ❌. Reaction work is best effort. If removing 👀 fails, Friday still attempts the final ✅ or ❌ and logs the reaction failure. If the source capability itself is unavailable, reactions are impossible and Friday logs that no reaction was attempted. Friday never posts a source-conversation text error.

Inbound handoffs are durably deduplicated by source connection and source message ID. Handoff rows are retained as historical records after link removal and after either endpoint connection is removed. Each row keeps the link ID plus source and destination endpoint snapshots for diagnosis. Recreating the same connection and link does not clear the claim, so delayed gateway redelivery still cannot create another thread. Friday does not scan or resume failed handoffs at startup in v1. There is a narrow Discord API ambiguity if the process crashes after creating the external destination thread but before persisting that creation.

## Sending an update back

Only linked destination ChannelThreads receive the `linked_channel_update` tool. Ordinary channel threads, bootstrap threads, and agent threads do not receive it.

The tool sends one text message to the exact persisted source conversation. It accepts up to 1900 characters and at most ten exact Discord user IDs. It verifies source-guild membership when Discord supports the lookup, deduplicates IDs, and validates the final 2000-character Discord payload.

Friday reauthorizes every send against the current reloadable configuration. The same link ID and exact source and destination endpoints must still be enabled. Channel sources reauthorize against their own channel policy. Thread sources reauthorize against the parent channel recorded at handoff time, then post to the exact persisted thread. Legacy or malformed linked-thread provenance without a trustworthy parent fails closed. Removing, disabling, or retargeting a link makes old operator threads fail closed. Friday never silently retargets them.

Imported source assignment text does not authorize posting. Friday marks the synthetic handoff turn non-authorizing at ingestion and the outbound tool rejects execution for that turn. Each later destination participant turn receives a fresh authorizing current-turn context, and Friday clears it when the turn ends. A participant in the operator thread must explicitly request each outbound send. The adapter creates user mention tokens only for the exact requested IDs and sends `allowed_mentions` with an empty parse list, the verified user list, no roles, and `replied_user: false`. Role mentions, everyone or here, unlisted user tokens, and reply pings remain inert.

V1 has no outbound idempotency or audit table. A narrow retry can duplicate an outbound message. Existing tool activity remains the operator-visible record. If initial turn dispatch fails after Friday persists the operator ChannelThread, the failed handoff retains that thread rather than attempting destructive cleanup of the Discord thread or local record.
