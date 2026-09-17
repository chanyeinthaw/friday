# 02. Runtime and delivery reliability

## Current inbound flow

```text
Chat SDK callback
  project raw platform event
  resolve access policy
  deduplicate and decide invocation
  find or create Friday thread
  persist pending turn
  start Pi prompt
  wait for terminal Pi event
  persist terminal turn
  finalize or publish platform message
  resolve Chat SDK callback Promise
```

This order preserves conversation state before final publication, which is correct. The problem is
that durable acceptance, model execution, and platform delivery share one callback lifetime.

## Finding R1: new-turn acknowledgement waits for the full turn

Severity: high
Claim: observed behavior, platform consequence is an inferred risk

[`ChatSdkLifecycle.ts`](../../apps/friday/src/platforms/chat-sdk/ChatSdkLifecycle.ts) forks the
inbound effect into the application scope and immediately joins the fiber. That effect reaches
[`PlatformIngestion.ingest`](../../apps/friday/src/platforms/PlatformIngestion.ts), which waits on
[`ChannelTurns.accept`](../../apps/friday/src/conversation/ChannelTurns.ts). When the message starts
a turn, `ChannelTurns.accept` does not return until the terminal event and final publication path
finish. A message successfully delivered as steering returns without waiting for that active turn.

Consequences:

- Model execution time becomes platform handler latency.
- Platform retry behavior can overlap with a still-running Friday turn.
- A graceful shutdown must wait for or interrupt work still attached to callback fibers.
- Chat SDK transport semantics and agent runtime semantics remain unnecessarily coupled.

The repository's own Chat SDK research proposed resolving the callback after persistence and
submission, not after the complete turn. The implementation has not yet established that boundary.

### Recommendation

Return a durable acceptance result from ingestion:

```ts
type InboundAcceptance =
  | { readonly disposition: 'started'; readonly turnId: TurnId }
  | { readonly disposition: 'steered'; readonly turnId: TurnId }
  | { readonly disposition: 'ignored' }
```

Resolve the Chat SDK callback after the turn or steering activity is persisted and handed to the
coordinator. Make acceptance idempotent by canonical platform message ID. If the existing Chat SDK
deduplication window is not a sufficient durable guarantee, add a unique inbound receipt that points
to the accepted turn and disposition. Continue terminal waiting in a scoped application worker.

## Finding R2: completed output has no durable delivery state

Severity: high
Claim: observed

[`ThreadCoordinator.ts`](../../apps/friday/src/conversation/ThreadCoordinator.ts) persists terminal
events before signaling completion. This is a strong invariant. After that,
[`ChannelProgress.finalize`](../../apps/friday/src/conversation/ChannelProgress.ts) attempts to edit
the working message and falls back to a new publication. Both attempts are bounded and failures are
logged, then discarded.

SQLite records the turn as completed but records no delivery intent, platform message ID, attempt
count, or delivery outcome. Restarting Friday cannot discover that the user never received the
response.

### Recommendation

Add one small SQLite-backed outbound delivery queue. Avoid a general job framework.

```text
outbound_deliveries
  id
  turn_id
  platform
  connection_id
  conversation_id
  payload
  status             pending | delivering | delivered | failed
  attempt_count
  next_attempt_at
  platform_message_id nullable
  last_error nullable
```

Persist the delivery record in the same transaction as terminal turn state where practical. A
scoped worker claims pending rows, publishes with bounded backoff, and records success. Because
platform posting is not generally idempotent, save the returned platform message ID and define how
an interrupted `delivering` row is retried. Editing the existing working message is preferable when
its ID is known.

## Finding R3: restart leaves active turns orphaned

Severity: high
Claim: observed

`pending` and `running` are durable turn states. A fresh
[`PiThreadRuntime`](../../apps/friday/src/harness/pi/PiThreadRuntime.ts) initializes its in-memory
`activeTurnId` to `null`, even when it opens an existing Pi session file. No startup or thread-open
reconciliation updates unfinished turns.

On the next message, `ChannelTurns` sees the persisted active turn and attempts steering. The new
runtime rejects steering because it has no active turn. Friday then starts a new turn, which keeps
the conversation usable, but the old record remains nonterminal indefinitely.

The same concern applies to background tasks. Detached task watchers are process-local, and the new
process does not reinstall completion watchers for work that was active before shutdown.

### Recommendation

Choose one explicit recovery policy:

1. **Interrupt on recovery.** On startup or first thread acquisition, transactionally mark orphaned
   `pending` and `running` turns as interrupted with a process-restart reason. This is the simplest
   honest policy.
2. **Resume.** Only choose this if Pi exposes a reliable way to determine and resume an active turn,
   including terminal event replay. Session history alone is not enough.

Start with interruption. Add resumption later only when the harness contract supports it directly.

## Finding R4: side work uses detached fibers

Severity: low
Claim: observed

Conversation title generation and task completion work use `Effect.forkDetach`. Detachment is
intentional for background behavior, but it also removes structured shutdown and completion
ownership. The work captures services whose resources belong to the application scope.

### Recommendation

Create an application-owned background scope or queue. Fork title generation and task completion
delivery into that scope. On shutdown, apply a bounded drain period, then interrupt what remains.
The outbound delivery queue proposed above should own user-visible task completion messages.

## Existing strengths to preserve

- Per-binding and per-thread semaphores make the new-turn versus steering decision deterministic.
- A turn is persisted before `runtime.prompt` starts.
- Runtime events are persisted before terminal waiters are signaled.
- The runtime pool does not reap active turns.
- Steering persistence happens before delivery to Pi.
- Progress updates are bounded so cosmetic platform failures cannot block model work.

These invariants are good. The proposed change adds durable acceptance and delivery around them.
