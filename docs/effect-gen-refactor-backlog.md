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

## Inventory (6 remaining, GEN-037–GEN-042; B12 done)

| ID      | Pri | File                                                        | Function / range                    | Rationale                                             | Risk   | Tests                                                       | Semantic boundary                                |
| ------- | --- | ----------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------- | ------ | ----------------------------------------------------------- | ------------------------------------------------ |
| GEN-037 | 37  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | `desiredDescription` L303-320       | Per-channel fallback plus packing limit               | low    | `platforms/discord/DiscordAgentActivity.test.ts`            | fallback vs truncation                           |
| GEN-038 | 38  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | `publishLatest` L321-356            | Retry loop plus last-write guard plus transient check | high   | `platforms/discord/DiscordAgentActivity.test.ts`            | attempt loop vs lastDescription update           |
| GEN-039 | 39  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | `cleanupOwnedDescription` L357-375  | Owned guard plus clearing patch                       | low    | `platforms/discord/DiscordAgentActivity.test.ts`            | owned check vs clear exactly-once                |
| GEN-040 | 40  | `apps/friday/src/platforms/DiscordActivityDescriptions.ts`  | `watch` refresh L155-175            | Change detection plus callback plus swallowed failure | low    | `platforms/DiscordActivityDescriptions.integration.test.ts` | previous compare vs callback, polling untouched  |
| GEN-041 | 41  | `apps/friday/src/platforms/discord/DiscordAgentActivity.ts` | watch callback L407-414             | Enabled guard plus conditional cleanup plus offer     | low    | `platforms/discord/DiscordAgentActivity.test.ts`            | toggle guard vs cleanup vs signal                |
| GEN-042 | 42  | `apps/friday/src/harness/pi/PiThreadRuntime.ts`             | subscribe compaction chain L599-612 | Drain plus projection plus logged failure             | medium | `harness/pi/PiThreadRuntime.test.ts`                        | drain precedes projection, never fails subscribe |

Excluded as non-candidates (spot check): `main.ts` service delegations,
`Cli.ts` decode `flatMap`s, `SqliteThreadPersistence` encode-then-insert
primitives and simple `get*` projections, `DiscordConnections.platformOf` /
`list` / `get`, `ModelConfiguration.getProfile` / `addProfile`,
`PlatformRegistry.find` delegation, `ChatSdkLifecycle` already-gen handler,
`DiscordChannelBootstrap.create` already-gen, `PiTextGeneration` already-gen,
`ControlSocket` promise-based lock protocol, `WorkspaceCleanup` already-gen
`apply`/`propose`, `contracts/*` (no Effect chains).

## Batches (B12 done; 2 remaining)

- B01 (done): GEN-001, GEN-002, GEN-003. Foundations, all low risk.
- B02 (done): GEN-004, GEN-005, GEN-006. Coupled persistence guards, all low.
- B03 (done): GEN-007, GEN-008, GEN-009. Coupled enable/disable plus guard, all low.
- B04 (done): GEN-010, GEN-011, GEN-012. Coupled add/remove plus low companion.
- B05 (done): GEN-013, GEN-014, GEN-015. Transactional unchanged-guard pattern.
- B06 (done): GEN-016, GEN-017, GEN-018. Coupled guild policy trio, same file.
- B07 (done): GEN-019, GEN-020, GEN-021. Coupled guild singles, all low.
- B08 (done): GEN-022, GEN-023, GEN-024. Retired as already-compliant (outer Effect.gen; inner map/mapError only), no code churn.
- B09 (done): GEN-025, GEN-026, GEN-027. Retired as already-compliant (outer/inner Effect.gen; remaining pipes are mapError/catchCause/ensuring/onError/fork only), no code churn.
- B10 (done): GEN-029 (high), GEN-028 (low), GEN-030 (low). GEN-029 retired as already-compliant (outer Effect.fn generator; inner mapError/fork/catchCause/ensuring/onError only), no churn; GEN-028 title sidecar and GEN-030 send linearized.
- B11 (done): GEN-031 steer linearized; GEN-032 retired as already-compliant (the Effect.fn generator already linearizes the sequence read, upsert, and turn projection, with only pure guards remaining); GEN-033 registry read linearized. No test or coverage-only changes.
- B12 (done): GEN-034 `channelName`, GEN-035 `currentApplication`, and GEN-036 `patchDescription` retired as already-compliant. Each `Effect.fn` body already linearizes its business decisions and dependent effects; the remaining pipes are error mapping or intentional error swallowing. No production code churn; no test or coverage-only changes.
- B13 (next): GEN-037 (low), GEN-038 (high), GEN-039 (low). High isolated with lows.
- B14: GEN-040, GEN-041, GEN-042. Event and polling tail, low to medium.

First next batch is B13: GEN-037 `desiredDescription`, GEN-038 `publishLatest`,
GEN-039 `cleanupOwnedDescription`.

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
