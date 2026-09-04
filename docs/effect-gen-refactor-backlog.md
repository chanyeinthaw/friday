# Effect.gen refactor backlog (temporary)

> Temporary planning inventory. Delete this file when all batches are done.
> Not a permanent style policy. The coding rule itself belongs in
> AGENTS/project guidance, not here.

Scope: production TypeScript in `apps/friday/src` and `packages/contracts/src`
at PR #27 HEAD `266d236`. Excludes tests, `tools/**`, generated code.

Strict candidate rule: only nested/chained Effect code expressing business
logic with dependent operations, decisions, guards, or ordered side effects.
Excluded: composition-only pipes, `map`/`mapError`/`tap`/log annotation,
retries/schedules, provisioning, declarative Layer/Schema/Stream, simple
projections and decodes. No mechanical conversions.

Work three at a time in batch order. Verify each batch with
`pnpm format:check && pnpm lint && pnpm check && pnpm test` before the next.

## Already refactored in PR #27 (excluded, 10)

- `WorkspaceCleanupNotifications.ts` notification fan-out (`forEach` body)
- `ThreadCoordinator.ts` `deliver` failure path
- `ThreadRuntimePool.ts` terminal bookkeeping (`awaitTerminal` + clock)
- `Tasks.ts` `bootstrap` realPath/stat gate
- `ChannelTurns.ts` terminal to `progress.finalize`
- `DiscordLive.ts` inbound allow/bind gate
- `Tasks.ts` `requireOwnedTask` guards
- `DiscordConnections.ts` `updateConnection` platform gate
- `DiscordGuilds.ts` `disableGuild` update + exists fallback
- `HarnessReload.ts` `reloadConversationHarness` thread lookup

## Inventory (42 candidates)

| ID      | Pri | File                                                        | Function / range                    | Rationale                                                  | Risk   | Tests                                                                                | Semantic boundary                                |
| ------- | --- | ----------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| GEN-001 | 1   | `apps/friday/src/tasks/Tasks.ts`                            | `requireChannelThread` L168-186     | Channel lookup plus audience guard reads as nested match   | low    | `tasks/Tasks.integration.test.ts`                                                    | missing vs non-channel must stay distinct        |
| GEN-002 | 2   | `apps/friday/src/tasks/Tasks.ts`                            | `resolveProfile` L146-166           | Default-vs-named resolve plus missing-profile guard        | low    | `tasks/Tasks.integration.test.ts`, `tasks/TaskModels.test.ts`                        | default vs named resolution, typed error         |
| GEN-003 | 3   | `apps/friday/src/config/ModelConfiguration.ts`              | `getModel` L202-210                 | List then find-or-fail lookup                              | low    | `config/ModelConfiguration.integration.test.ts`                                      | missing-model error vs found                     |
| GEN-004 | 4   | `apps/friday/src/persistence/SqliteThreadPersistence.ts`    | `closeThread` L396-411              | Get plus none-swallowing guarded update                    | low    | `persistence/SqliteThreadPersistence.integration.test.ts`                            | missing swallow vs closed transition             |
| GEN-005 | 5   | `apps/friday/src/persistence/SqliteThreadPersistence.ts`    | `setThreadHarnessSession` L412-425  | Same guard shape, coupled with close                       | low    | `persistence/SqliteThreadPersistence.integration.test.ts`                            | missing swallow vs session assignment            |
| GEN-006 | 6   | `apps/friday/src/persistence/SqliteThreadPersistence.ts`    | `updateExistingTurn` L304-318       | Shared get-plus-conditional-update helper                  | low    | `persistence/SqliteThreadPersistence.integration.test.ts`                            | missing swallow vs turn rewrite                  |
| GEN-007 | 7   | `apps/friday/src/config/DiscordConnections.ts`              | `enableConnection` L414-432         | Optimistic update plus fallback platform read              | low    | `config/DiscordConnections.test.ts`, `config/DiscordConnections.integration.test.ts` | enabled vs already-enabled vs missing            |
| GEN-008 | 8   | `apps/friday/src/config/DiscordConnections.ts`              | `disableConnection` L433-452        | Mirror of enable, keep coupled                             | low    | `config/DiscordConnections.test.ts`, `config/DiscordConnections.integration.test.ts` | disabled vs already-disabled vs missing          |
| GEN-009 | 9   | `apps/friday/src/config/DiscordGuilds.ts`                   | `requireDiscordConnection` L244-266 | Platform read plus three-way typed error                   | low    | `config/DiscordGuilds.integration.test.ts`                                           | discord vs unknown vs non-discord                |
| GEN-010 | 10  | `apps/friday/src/config/DiscordConnections.ts`              | `addConnection` L282-320            | Existence gate plus owner check plus two inserts           | medium | `config/DiscordConnections.test.ts`, `config/DiscordConnections.integration.test.ts` | gate vs app-owner check vs inserts atomic        |
| GEN-011 | 11  | `apps/friday/src/config/DiscordConnections.ts`              | `removeConnection` L321-347         | Platform gate plus ordered deletes plus outcome            | medium | `config/DiscordConnections.test.ts`, `config/DiscordConnections.integration.test.ts` | missing vs removed, delete order                 |
| GEN-012 | 12  | `apps/friday/src/config/ModelConfiguration.ts`              | `removeProfile` L275-288            | Protected guard plus delete plus outcome                   | low    | `config/ModelConfiguration.integration.test.ts`                                      | protected vs missing vs removed                  |
| GEN-013 | 13  | `apps/friday/src/config/ModelConfiguration.ts`              | `setModel` L211-231                 | Transactional unchanged check plus branched update         | medium | `config/ModelConfiguration.integration.test.ts`                                      | unchanged vs primary vs utility write            |
| GEN-014 | 14  | `apps/friday/src/config/ModelConfiguration.ts`              | `updateProfile` L250-274            | Read plus missing/unchanged guards plus update             | medium | `config/ModelConfiguration.integration.test.ts`                                      | missing vs unchanged vs updated                  |
| GEN-015 | 15  | `apps/friday/src/config/DiscordGuilds.ts`                   | `enableGuild` L504-526              | Require plus re-enable plus insert-or-ignore               | medium | `config/DiscordGuilds.integration.test.ts`                                           | re-enabled vs inserted vs already-enabled        |
| GEN-016 | 16  | `apps/friday/src/config/DiscordGuilds.ts`                   | `setGuildInvocation` L555-582       | Require plus read/missing/unchanged guards plus update     | medium | `config/DiscordGuilds.integration.test.ts`                                           | missing vs unchanged vs updated                  |
| GEN-017 | 17  | `apps/friday/src/config/DiscordGuilds.ts`                   | `setGuildUsers` L583-626            | Normalized compare plus two-table write                    | medium | `config/DiscordGuilds.integration.test.ts`                                           | normalization plus unchanged vs write atomic     |
| GEN-018 | 18  | `apps/friday/src/config/DiscordGuilds.ts`                   | `setGuildChannelScope` L627-670     | Mirror of users, keep coupled                              | medium | `config/DiscordGuilds.integration.test.ts`                                           | same boundary as users, scope table              |
| GEN-019 | 19  | `apps/friday/src/config/DiscordGuilds.ts`                   | `removeGuild` L539-554              | Require plus delete plus outcome map                       | low    | `config/DiscordGuilds.integration.test.ts`                                           | missing vs removed                               |
| GEN-020 | 20  | `apps/friday/src/config/DiscordGuilds.ts`                   | `resetChannel` L680-697             | Require plus delete plus outcome map                       | low    | `config/DiscordGuilds.integration.test.ts`                                           | missing vs removed                               |
| GEN-021 | 21  | `apps/friday/src/config/DiscordGuilds.ts`                   | `setChannel` outer L671-679         | Require plus delegated transaction                         | low    | `config/DiscordGuilds.integration.test.ts`                                           | require must precede transaction                 |
| GEN-022 | 22  | `apps/friday/src/tasks/Tasks.ts`                            | `start` L627-645                    | Channel plus directory guards plus launch                  | low    | `tasks/Tasks.integration.test.ts`                                                    | guard order, launch delegation                   |
| GEN-023 | 23  | `apps/friday/src/tasks/Tasks.ts`                            | `validateWorkingDirectory` L213-270 | Realpath/stat plus containment guards                      | medium | `tasks/Tasks.integration.test.ts`, `tasks/TaskPolicy.test.ts`                        | existence vs type vs containment errors          |
| GEN-024 | 24  | `apps/friday/src/tasks/Tasks.ts`                            | `list` L844-883                     | N+1 turn reads plus null filtering plus status filter      | medium | `tasks/Tasks.integration.test.ts`                                                    | missing-turn filter vs decode vs filter          |
| GEN-025 | 25  | `apps/friday/src/tasks/Tasks.ts`                            | `cancel` L884-933                   | Ownership plus active guard plus lifecycle cancel          | medium | `tasks/Tasks.integration.test.ts`                                                    | already-terminal vs cancel vs publish            |
| GEN-026 | 26  | `apps/friday/src/tasks/Tasks.ts`                            | launch delivery fork L596-624       | Close plus cancelled guard plus channel accept             | medium | `tasks/Tasks.integration.test.ts`                                                    | cancelled check, exactly-once delivery           |
| GEN-027 | 27  | `apps/friday/src/tasks/Tasks.ts`                            | steer delivery fork L820-843        | Same delivery shape, coupled with launch                   | medium | `tasks/Tasks.integration.test.ts`                                                    | same boundary as launch delivery                 |
| GEN-028 | 28  | `apps/friday/src/platforms/PlatformIngestion.ts`            | title sidecar L132-152              | Title generate plus publish plus swallowed failure         | low    | `platforms/PlatformIngestion.test.ts`                                                | failure stays swallowed and forked               |
| GEN-029 | 29  | `apps/friday/src/tasks/Tasks.ts`                            | `launchTaskUnlocked` L429-595       | Worktree isolation plus thread/turn build plus open/prompt | high   | `tasks/Tasks.integration.test.ts`                                                    | isolation decision vs build vs prompt            |
| GEN-030 | 30  | `apps/friday/src/platforms/testing/TestPlatform.ts`         | `send` L71-79                       | Record event plus resolve handler plus invoke              | low    | `platforms/testing/TestPlatform.test.ts`                                             | record must precede handler                      |
| GEN-031 | 31  | `apps/friday/src/tasks/Tasks.ts`                            | `steer` orchestration L734-819      | Owned/latest guards plus active-vs-idle branch             | high   | `tasks/Tasks.integration.test.ts`                                                    | steer-active vs continuation-idle                |
| GEN-032 | 32  | `apps/friday/src/persistence/SqliteThreadPersistence.ts`    | `putActivitySnapshot` L319-388      | Sequence read plus upsert plus turn projection             | medium | `persistence/SqliteThreadPersistence.integration.test.ts`                            | sequence vs upsert vs projection atomic          |
| GEN-033 | 33  | `apps/friday/src/repositories/RepositoryWorktrees.ts`       | `readWorktreeRegistry` L269-302     | Missing-vs-invalid registry distinction                    | low    | `repositories/RepositoryWorktrees.test.ts`                                           | ENOENT-null vs invalid error                     |
| GEN-034 | 34  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | `channelName` L203-235              | Cache guard plus fetch plus decode plus store              | low    | `platforms/discord/DiscordAgentActivity.test.ts`                                     | cache hit vs fetch vs decode                     |
| GEN-035 | 35  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | `currentApplication` L236-264       | Fetch plus ok-guard plus decode                            | low    | `platforms/discord/DiscordAgentActivity.test.ts`                                     | HTTP-ok guard vs decode                          |
| GEN-036 | 36  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | `patchDescription` L265-302         | Ownership guards plus PATCH plus 429 handling              | medium | `platforms/discord/DiscordAgentActivity.test.ts`                                     | ownership vs PATCH vs rate-limit                 |
| GEN-037 | 37  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | `desiredDescription` L303-320       | Per-channel fallback plus packing limit                    | low    | `platforms/discord/DiscordAgentActivity.test.ts`                                     | fallback vs truncation                           |
| GEN-038 | 38  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | `publishLatest` L321-356            | Retry loop plus last-write guard plus transient check      | high   | `platforms/discord/DiscordAgentActivity.test.ts`                                     | attempt loop vs lastDescription update           |
| GEN-039 | 39  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | `cleanupOwnedDescription` L357-375  | Owned guard plus clearing patch                            | low    | `platforms/discord/DiscordAgentActivity.test.ts`                                     | owned check vs clear exactly-once                |
| GEN-040 | 40  | `apps/friday/src/platforms/DiscordActivityDescriptions.ts`  | `watch` refresh L155-175            | Change detection plus callback plus swallowed failure      | low    | `platforms/DiscordActivityDescriptions.integration.test.ts`                          | previous compare vs callback, polling untouched  |
| GEN-041 | 41  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | watch callback L407-414             | Enabled guard plus conditional cleanup plus offer          | low    | `platforms/discord/DiscordAgentActivity.test.ts`                                     | toggle guard vs cleanup vs signal                |
| GEN-042 | 42  | `apps/friday/src/harness/pi/PiThreadRuntime.ts`             | subscribe compaction chain L599-612 | Drain plus projection plus logged failure                  | medium | `harness/pi/PiThreadRuntime.test.ts`                                                 | drain precedes projection, never fails subscribe |

Excluded as non-candidates (spot check): `main.ts` service delegations,
`Cli.ts` decode `flatMap`s, `SqliteThreadPersistence` encode-then-insert
primitives and simple `get*` projections, `DiscordConnections.platformOf` /
`list` / `get`, `ModelConfiguration.getProfile` / `addProfile`,
`PlatformRegistry.find` delegation, `ChatSdkLifecycle` already-gen handler,
`DiscordChannelBootstrap.create` already-gen, `PiTextGeneration` already-gen,
`ControlSocket` promise-based lock protocol, `WorkspaceCleanup` already-gen
`apply`/`propose`, `contracts/*` (no Effect chains).

## Batches (14 x 3)

- B01 (next): GEN-001, GEN-002, GEN-003. Foundations, all low risk.
- B02: GEN-004, GEN-005, GEN-006. Coupled persistence guards, all low.
- B03: GEN-007, GEN-008, GEN-009. Coupled enable/disable plus guard, all low.
- B04: GEN-010, GEN-011, GEN-012. Coupled add/remove plus low companion.
- B05: GEN-013, GEN-014, GEN-015. Transactional unchanged-guard pattern.
- B06: GEN-016, GEN-017, GEN-018. Coupled guild policy trio, same file.
- B07: GEN-019, GEN-020, GEN-021. Coupled guild singles, all low.
- B08: GEN-022, GEN-023, GEN-024. Task setup and reads, no high risk.
- B09: GEN-025, GEN-026, GEN-027. Task cancel plus coupled deliveries.
- B10: GEN-029 (high), GEN-028 (low), GEN-030 (low). High isolated with lows.
- B11: GEN-031 (high), GEN-032 (medium), GEN-033 (low). High isolated.
- B12: GEN-034, GEN-035, GEN-036. Coupled activity fetch chain.
- B13: GEN-037 (low), GEN-038 (high), GEN-039 (low). High isolated with lows.
- B14: GEN-040, GEN-041, GEN-042. Event and polling tail, low to medium.

First next batch is B01: GEN-001 `requireChannelThread`, GEN-002
`resolveProfile`, GEN-003 `getModel`.

## Limitations

- Best-effort static scan at one HEAD; line ranges drift with edits.
- Borderline single-guard plus single-write cases kept only where an outcome
  decision exists; pure two-op `andThen` sequences without guards excluded.
- Promise-based workflows (`ControlSocket` lock, `PiTaskTool`, Discord activity
  tryPromise handler) excluded: no Effect chain to linearize.
- Already-`Effect.gen` bodies excluded even when inner pipes remain; inner
  `map`/`mapError`/`tap`/log-only pipes intentionally left alone.
- `packages/contracts/src` has no Effect chains, so all candidates are in
  `apps/friday/src`.
