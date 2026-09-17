# 07. Prioritized roadmap

## Closure status

This roadmap was closed on 2026-09-18. The original recommendations below remain unchanged as the
audit record. Their final dispositions are:

| #   | Recommendation                                    | Disposition                                                      |
| --- | ------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Separate acceptance from completion               | Implemented by PR #55                                            |
| 2   | Add a minimal outbound delivery queue             | Deferred; durable delivery is not justified yet                  |
| 3   | Reconcile orphaned turns and tasks                | Implemented by PR #56                                            |
| 4   | Add pull-request CI                               | Implemented at the chosen PR-only scope by PR #57                |
| 5   | Establish a lint warning baseline                 | Not scheduled                                                    |
| 6   | Split the CLI by command family                   | Implemented by PR #59                                            |
| 7   | Extract platform connection builders              | Implemented by PR #60                                            |
| 8   | Centralize migration execution                    | Centralization implemented by PR #58; migration ledger deferred  |
| 9   | Model platform capabilities explicitly            | Implemented by PR #61                                            |
| 10  | Return activation semantics from config mutations | Not planned; current restart semantics are an intentional choice |
| 11  | Resolve document storage consistency              | Not planned; documents are temporary                             |
| 12  | Close operational gaps                            | Accepted as external; document backup is not required            |

Task orchestration was also split by use case in PR #62 after the audit roadmap work.

## Guiding decision

Keep the current architecture. Improve reliability at the durable boundaries, then reduce the few
modules with excessive ownership. Do not start with folder churn, a new database, a message broker,
or a generic plugin system.

## Phase 1: make delivery recoverable

### 1. Separate acceptance from completion

Change platform ingestion to return once a new turn or steering activity has been durably accepted.
Make the acceptance idempotent by canonical platform message ID, then move terminal waiting into an
application-owned worker scope.

Exit criteria:

- Chat SDK callbacks resolve without waiting for model completion.
- A persisted turn cannot be submitted twice because of transport retry.
- Steering disposition remains serialized per binding.

### 2. Add a minimal outbound delivery queue

Persist final user-visible output and retry state in SQLite. Reuse the working message when its
platform ID is available. Keep delivery platform-neutral above `PlatformAdapter`.

Exit criteria:

- A completed turn with a failed publication remains discoverable.
- Restart resumes pending delivery.
- Retry is bounded and observable.
- Duplicate publication behavior is specified and tested.

### 3. Reconcile orphaned turns and tasks

On startup or first acquisition, mark process-orphaned active turns interrupted. Use a precise
reason such as `process-restarted`. Reconcile task activity derived from those turns.

Exit criteria:

- No turn remains `pending` or `running` solely because the previous process exited.
- Task inspection reports terminal state after restart.
- New input never needs stale-turn steering as its recovery mechanism.

## Phase 2: put checks before release

### 4. Add pull-request CI

Run frozen install and `pnpm verify` for pull requests and `main`. Build one binary target. Keep full
multi-platform builds in the release workflow.

### 5. Establish a lint warning baseline

Fix production warnings that indicate real issues, document narrow exceptions, and reject new
warnings in CI.

## Phase 3: reduce change amplification

### 6. Split the CLI by command family

Retain the typed action union and exhaustiveness checks. Move parser, help, rendering, and handler
logic into family modules. Replace the 59-method root options object with smaller family services or
handler records.

### 7. Extract platform connection builders

Move per-connection construction out of `DiscordLive.ts` and `SlackLive.ts`. Keep shared behavior
limited to mechanics with identical ordering and failure semantics.

### 8. Centralize migration execution

Run migrations once before constructing SQL-backed services. Add a ledger for new migrations while
leaving existing defensive schema checks intact.

## Phase 4: clarify optional behavior and operations

### 9. Model platform capabilities explicitly

Replace successful no-ops with optional typed capability groups. Make fallback behavior visible at
call sites.

### 10. Return activation semantics from configuration mutations

Distinguish unchanged, applied live, and restart required. Do not invoke live reload for a mutation
that cannot affect the running topology.

### 11. Resolve document storage consistency

Store bounded content in SQLite or introduce immutable file generations with database pointers and
garbage collection.

### 12. Close operational gaps

Verify log rotation, SQLite and document backups, reverse-proxy auth redaction, and restore
procedures. Put the results in repository documentation.

## Recommended issue breakdown

| Issue                             | Scope                             | Depends on                                 |
| --------------------------------- | --------------------------------- | ------------------------------------------ |
| Durable inbound acceptance result | conversation + Chat SDK lifecycle | None                                       |
| SQLite outbound delivery queue    | persistence + platform registry   | Acceptance result                          |
| Restart turn reconciliation       | persistence + runtime pool        | None                                       |
| PR verification workflow          | `.github/workflows`               | None                                       |
| CLI family extraction             | CLI only                          | Reliability work can proceed independently |
| Single migration entry point      | persistence + live composition    | None                                       |
| Explicit adapter capabilities     | platform adapter + callers        | Delivery queue design                      |
| Typed config activation outcome   | config + CLI                      | None                                       |
| Document content consistency      | documents + persistence           | None                                       |

## Changes not recommended now

- Do not replace SQLite. It matches the single-process deployment and already supports the needed
  transactional semantics.
- Do not replace Effect. Resource scope, typed errors, concurrency control, and service injection are
  used well.
- Do not merge Discord and Slack implementations into a generic platform framework.
- Do not split `Migrations.ts` only to reduce file length. Change execution ownership first.
- Do not add Redis or an external queue for delivery. A SQLite table and scoped worker are enough.
- Do not chase a repository-wide coverage percentage. Add tests around identified failure modes.
