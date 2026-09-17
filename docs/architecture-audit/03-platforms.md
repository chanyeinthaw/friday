# 03. Platform architecture

## Current boundary

The platform layer has four distinct responsibilities:

```text
raw adapter event
  -> platform projection
  -> shared admission
  -> normalized PlatformInput
  -> shared ingestion

agent output
  -> PlatformRegistry
  -> PlatformAdapter
  -> platform SDK
```

This is the right shape. Discord and Slack raw objects do not leak into the conversation domain.

## What is working well

### Shared normalized contract

[`PlatformAdapter.ts`](../../apps/friday/src/platforms/PlatformAdapter.ts) defines publication,
acknowledgement, working-message lifecycle, conversation title, agent activity, search, and typing
operations around `ConversationBinding`. The registry selects adapters by `connectionId` and checks
that the platform kind also matches.

### Fail-closed admission

[`PlatformAdmission.ts`](../../apps/friday/src/platforms/PlatformAdmission.ts) owns the common order:
scope policy, user policy, duplicate check, binding lookup, invocation decision, and ingestion.
Platform hooks decide platform semantics from already normalized input. Adapter preflight drops
unknown or denied scopes before visible side effects, then shared admission repeats the authoritative
decision after projection. The duplication is deliberate and documented.

### Durable Chat SDK mechanics

[`SqliteChatStateAdapter.ts`](../../apps/friday/src/platforms/chat-sdk/SqliteChatStateAdapter.ts)
keeps subscriptions, leases, cache, bounded lists, and queues in separate SQLite tables. This is a
good fit for a resident single-process application and avoids a Redis dependency.

### Platform-specific details stay local

Slack canonical scope reconciliation, Discord native thread IDs, initial context, message search,
and channel bootstrap live in platform folders. The shared conversation layer sees only normalized
contracts.

## Finding P1: unsupported capabilities silently succeed

Severity: medium
Claim: observed

Every `PlatformAdapter` must implement every operation. Generic Chat SDK adapters default title and
activity changes to `Effect.void` and message search to an empty result. Slack implements agent
activity as `Effect.void`. Callers cannot distinguish successful execution from an unsupported
feature.

This will become harder to reason about as `linear`, `web`, or another platform is added.

### Recommendation

Keep one adapter identity and group optional capabilities:

```ts
interface PlatformAdapter<E> {
  readonly connectionId: PlatformConnectionId
  readonly kind: PlatformKind
  readonly messaging: PlatformMessaging<E>
  readonly workingMessage?: PlatformWorkingMessageCapability<E>
  readonly conversationTitle?: PlatformConversationTitleCapability<E>
  readonly agentActivity?: PlatformAgentActivityCapability<E>
  readonly messageSearch?: PlatformMessageSearchCapability<E>
}
```

Callers can then choose an explicit fallback or skip unsupported behavior. Do not add a generic
capability framework. Optional typed groups are enough.

## Finding P2: live connection modules are composition hotspots

Severity: medium
Claim: observed

[`DiscordLive.ts`](../../apps/friday/src/platforms/discord/DiscordLive.ts) imports 30 local modules.
[`SlackLive.ts`](../../apps/friday/src/platforms/slack/SlackLive.ts) imports 18. Each file constructs
the SDK adapter, resolves live policy, builds admission hooks, wires bootstrap and routing, starts
lifecycle resources, registers the platform adapter, and logs startup.

These modules are still readable, but new platform behavior tends to land in the same callback
literal. Tests increasingly need source-text wiring assertions because construction is hard to
observe through a narrow seam.

### Recommendation

Extract one connection builder per platform:

```text
DiscordLive
  load startup connections
  for each connection -> makeDiscordConnectionRuntime

makeDiscordConnectionRuntime
  adapter and Chat construction
  policy provider
  admission hooks
  bootstrap and routing
  lifecycle and registration
```

Do the same for Slack. Keep platform semantics in the current focused modules. The goal is a smaller
composition function, not a new abstraction shared between unlike SDK APIs.

## Finding P3: platform handler completion and agent completion are conflated

Severity: high
Claim: observed

This is the platform side of finding R1. Chat SDK handlers that start a turn await Friday's complete
turn. Platform adapter code therefore participates in the lifetime of model work and final
publication.

### Recommendation

Make `onInboundMessage` return after a durable acceptance result. A separate application worker
owns terminal waiting and output delivery. See [runtime and delivery](02-runtime-and-delivery.md).

## Finding P4: platform parity is implemented by parallel modules

Severity: low
Claim: observed

Discord and Slack each have conversation scope, channel bootstrap, initial context, message
projection, message search, thread routing, access policy, and live composition modules. This is
mostly healthy because the platform semantics differ. The shared admission and working-message
lifecycle already capture the truly common mechanics.

### Recommendation

Do not merge the parallel platform modules into generic parameter objects. Continue extracting only
behavior with identical ordering and failure semantics. `PlatformAdmission` and
`WorkingMessageLifecycle` are good examples of the right threshold.
