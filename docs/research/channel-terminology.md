# Friday channel terminology research

## Question

What term should replace Friday's former `Surface` abstraction for a user-facing input/output path such as Discord, Slack, Linear, Web, or Test?

## Primary-source comparison

### OpenClaw

OpenClaw consistently uses **channel** for the product-facing integration category:

- The repository describes itself as a multi-channel gateway and says that channel plugins connect chat applications to agents: <https://github.com/openclaw/openclaw/blob/main/docs/index.md>
- The public plugin contract is `ChannelPlugin`, with a channel `id`, metadata, lifecycle, gateway, outbound, messaging, threading, and other channel-owned capabilities: <https://github.com/openclaw/openclaw/blob/main/src/channels/plugins/types.plugin.ts>
- Channel types are grouped under `src/channels/`, including plugins, inbound events, messages, transport, and turns: <https://github.com/openclaw/openclaw/tree/main/src/channels>
- OpenClaw uses **Gateway** for the resident process that owns routing and channel connections, not for an individual chat integration.

OpenClaw therefore separates these concepts:

```text
ChannelPlugin   = Discord / Slack / Telegram integration capability
channelId       = a channel kind or native channel identifier, depending on context
chat/channel    = a concrete user-facing location
session         = the durable agent conversation
Gateway         = the resident process
```

### Hermes

Hermes uses a more implementation-oriented vocabulary:

- The gateway owns `platforms/`, with one adapter per Telegram, Discord, Slack, WhatsApp, and other platform: <https://github.com/NousResearch/hermes-agent/tree/main/gateway/platforms>
- A gateway `SessionSource` records the origin of a message with `platform`, `chat_id`, `chat_type`, `thread_id`, and related source metadata: <https://github.com/NousResearch/hermes-agent/blob/main/gateway/session.py>
- The gateway runner manages the lifecycle of platform adapters and message routing: <https://github.com/NousResearch/hermes-agent/blob/main/gateway/run.py>
- Hermes also uses **channel** for concrete messaging locations and a channel directory: <https://github.com/NousResearch/hermes-agent/blob/main/gateway/channel_directory.py>

Hermes therefore separates:

```text
platform        = Discord / Slack / Telegram integration category
SessionSource   = where a message came from
chat_id         = concrete chat or channel identifier
thread_id       = concrete conversation/thread identifier
session         = durable agent conversation
Gateway         = resident process
```

## Findings

1. **Surface was not a useful core term for Friday.** It is abstract and is not the primary adapter name in either repository.
2. **Channel has the strongest OpenClaw precedent.** It is a good product term, but Friday already uses `channelId` for a concrete native container, so using Channel for both levels would create ambiguity.
3. **Platform fits Friday's current model.** It names the communication system while leaving `channelId` and `conversationId` available for native locations.
4. **Gateway should remain the process-level term.** Both projects use Gateway for the long-lived resident owner.
5. **ConversationBinding describes the identity object more accurately than PlatformBinding.** The object binds a Friday Thread to one exact native conversation location; the Platform is one field inside that binding.

## Decision

Friday uses **Platform** for the user-facing communication system and **ConversationBinding** for the exact native conversation location.

```text
PlatformKind       = discord | slack | linear | web | test
PlatformAdapter    = one registered implementation for a PlatformKind
PlatformRegistry   = routes publication and typing operations by PlatformKind
ChannelId          = native parent-channel/container identifier
ConversationId     = native thread/topic/issue/session identifier
MessageId          = native initiating or inbound message identifier
ConversationBinding = Platform + native location identifiers
Friday Thread      = durable internal conversation
Gateway            = resident Friday process
```

The current contract is:

```ts
interface ConversationBinding {
  readonly platform: PlatformKind
  readonly channelId: PlatformChannelId
  readonly sourceMessageId: PlatformMessageId
  readonly conversationId: PlatformConversationId
}
```

Because Friday is still in development, the previous `Surface` JSON contract is not preserved. The local development database can be reset when the contract changes. A future released on-disk contract will introduce explicit compatibility migrations.
