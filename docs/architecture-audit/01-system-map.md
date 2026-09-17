# 01. System map

## Architectural shape

Friday is a standalone Bun executable backed by one SQLite database and local filesystem state.
It connects to Discord and Slack through Chat SDK adapters, runs Pi agent sessions, persists the
conversation lifecycle, and publishes progress and final responses back to the originating
platform.

```text
Discord gateway       Slack Socket Mode
       |                      |
       +------ Chat SDK ------+
                  |
          projection + admission
                  |
          PlatformIngestion
                  |
           ChannelTurns
                  |
     Friday -> ThreadRuntimePool
                  |
       ThreadCoordinator -> Pi runtime
                  |
       SQLite Thread / Turn / Activity
                  |
          ChannelProgress
                  |
          PlatformRegistry
                  |
         Discord / Slack output
```

The dependency graph has no production file cycles. `Live.ts` is the composition root for domain
services, while `main.ts` combines daemon startup and CLI operations.

## Package boundaries

```text
packages/contracts/
  Schema-defined conversation, task, model, message, and platform values

apps/friday/src/
  config/          SQLite-backed application and platform configuration
  control/         local owner-only reload socket
  conversation/    turn lifecycle, runtime pool, coordination, publication progress
  documents/       private document storage and HTTP serving
  harness/         harness-neutral contracts and Pi implementation
  identity/        scoped root-user prompt context
  persistence/     SQLite implementation and schema migration
  platforms/       normalized platform boundary and Slack/Discord adapters
  repositories/    managed Git worktrees and cross-process registry locking
  skills/          bundled operational skills
  tasks/           subagent lifecycle and task tooling
  workspaces/      cleanup proposal and approval workflow
```

`@friday/contracts` depends only on Effect. The application depends on the contracts package, and
the contracts package does not import application code. This is a clean dependency direction.

## Strong boundaries

### Schema-owned domain values

**Observed.** Branded identifiers and domain unions live in
[`packages/contracts/src/conversation`](../../packages/contracts/src/conversation). Runtime inputs
are decoded through Effect Schema rather than asserted into shape. The compiler runs with `strict`,
`exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` in
[`tsconfig.json`](../../tsconfig.json).

This makes persistence and platform translation failures explicit. It also keeps platform IDs,
thread IDs, turn IDs, task IDs, and model selections from collapsing into interchangeable strings.

### Effect service boundaries

**Observed.** The application defines 28 modules using `Context.Service`. Core interfaces include:

- [`ThreadPersistence`](../../apps/friday/src/conversation/ThreadPersistence.ts)
- [`ThreadRuntimePool`](../../apps/friday/src/conversation/ThreadRuntimePool.ts)
- [`PlatformRegistry`](../../apps/friday/src/platforms/PlatformRegistry.ts)
- [`PlatformIngestion`](../../apps/friday/src/platforms/PlatformIngestion.ts)
- [`Tasks`](../../apps/friday/src/tasks/Tasks.ts)
- [`Documents`](../../apps/friday/src/documents/Documents.ts)

Live construction stays out of the domain contracts. Effect layer memoization also prevents the
repeated `CoreLive` references in [`Live.ts`](../../apps/friday/src/Live.ts) from constructing the
same layer more than once within the application scope.

### Durable conversation ownership

**Observed.** Friday owns `Thread`, `Turn`, and `Activity` state. Chat SDK state uses separate
`chat_sdk_*` tables. This avoids conflating SDK subscription, cache, lease, and queue mechanics
with Friday's domain history. The separation is implemented in
[`SqliteThreadPersistence.ts`](../../apps/friday/src/persistence/SqliteThreadPersistence.ts) and
[`SqliteChatStateAdapter.ts`](../../apps/friday/src/platforms/chat-sdk/SqliteChatStateAdapter.ts).

### Scoped external resources

**Observed.** Chat SDK initialization and shutdown use `Effect.acquireRelease`. Runtime entries own
closeable scopes, idle runtimes are reaped, the document server registers a stop finalizer, and the
control socket closes live clients and checks socket identity before removing its file.

## Change hotspots

| Module                                                                                | Lines | Direct local imports | Architectural role                              |
| ------------------------------------------------------------------------------------- | ----: | -------------------: | ----------------------------------------------- |
| [`Cli.ts`](../../apps/friday/src/Cli.ts)                                              | 4,080 |                   14 | Parser, help, rendering, action model, dispatch |
| [`Tasks.ts`](../../apps/friday/src/tasks/Tasks.ts)                                    | 1,153 |                   11 | Task policy orchestration and lifecycle         |
| [`RepositoryWorktrees.ts`](../../apps/friday/src/repositories/RepositoryWorktrees.ts) | 1,114 |                    1 | Git operations and cross-process registry       |
| [`Migrations.ts`](../../apps/friday/src/persistence/Migrations.ts)                    | 1,060 |                    0 | Complete SQLite schema history                  |
| [`PiThreadRuntime.ts`](../../apps/friday/src/harness/pi/PiThreadRuntime.ts)           |   904 |                   11 | Pi bridge, event projection, steering, reload   |
| [`AppConfig.ts`](../../apps/friday/src/config/AppConfig.ts)                           |   807 |                    2 | Complete config decode and assembly             |
| [`DiscordLive.ts`](../../apps/friday/src/platforms/discord/DiscordLive.ts)            |   394 |                   30 | Discord connection composition                  |
| [`SlackLive.ts`](../../apps/friday/src/platforms/slack/SlackLive.ts)                  |   394 |                   18 | Slack connection composition                    |

Large files are not automatically defects. `Migrations.ts` is append-oriented history, and
`PiThreadRuntime.ts` owns one difficult integration boundary. `Cli.ts` is different because it
combines several independent reasons to change. The platform live files also have high fan-out and
deserve extraction as platform behavior grows.

## Overall assessment

The system has good boundaries at the type, service, and persistence levels. Complexity is mostly
localized rather than spread throughout the repository. The next architectural work should tighten
delivery semantics and reduce composition hotspots, not replace Effect or reorganize every folder.
