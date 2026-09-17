# Friday architecture audit

Audit date: 2026-09-17
Source revision: `d2e5556` (`main`, `v0.0.0-nightly.33`)
Closure date: 2026-09-18
Closure revision: `55e6e69` (`main`)
Audience: Friday maintainers
Status: closed; see [outcomes and decisions](08-outcomes-and-decisions.md)

## Executive conclusion

Friday has a sound architectural core. The code uses typed domain contracts, Effect services,
scoped resources, schema decoding at boundaries, a durable conversation model, and narrow
platform adapters. The production file graph is acyclic. This is not a rewrite candidate.

The largest risk is the delivery boundary. A Chat SDK callback that starts a new turn stays open
until the agent finishes and Friday attempts to publish the final response. Steering callbacks
return earlier. The turn is persisted before publication, but publication is best-effort and has no
durable outbox. A platform failure can therefore leave a correctly completed turn in SQLite with no
user-visible response and no automatic retry.

The second risk is restart recovery. `pending` and `running` turns survive in SQLite, but a new
process neither resumes nor reconciles them. The next message detects the stale turn, fails to
steer the new in-memory runtime, and starts another turn. Progress continues, but history retains a
turn that can remain active forever.

Fix those two boundaries before broad structural cleanup. After that, split the CLI and platform
composition modules, centralize migration ownership, and make platform capabilities explicit.

## Decision summary

| Priority | Finding                                                                          | Decision                                                          |
| -------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| High     | Inbound callbacks span the full model turn                                       | Acknowledge after durable acceptance, not after final publication |
| High     | Completed responses have no durable delivery state                               | Add a small SQLite outbound delivery queue with retry             |
| High     | Active turns are not reconciled after restart                                    | Mark orphaned work interrupted or implement explicit resumption   |
| Medium   | `Cli.ts` owns parsing, help, rendering, actions, and dispatch across 4,080 lines | Split by command family behind one typed command registry         |
| Medium   | Nine services run migrations as a construction side effect                       | Run migrations once at the application boundary                   |
| Medium   | Unsupported platform features silently succeed as no-ops                         | Model optional capabilities explicitly                            |
| Medium   | Stored config has mixed live and restart-only semantics                          | Return typed `applied-live` and `restart-required` outcomes       |
| Medium   | Verification runs only from the release-tag workflow                             | Add pull-request and `main` CI                                    |
| Low      | Private HTML uses a custom sanitizer                                             | Keep CSP, then replace or narrow raw HTML support                 |

## Current health snapshot

| Measure                              |             Observed result |
| ------------------------------------ | --------------------------: |
| Production TypeScript                |                25,344 lines |
| Test TypeScript                      |                31,471 lines |
| Production modules                   |                          96 |
| Test files                           |                         101 |
| Standard Vitest phase                |           669 tests passing |
| Integration tests                    | 115 passing across 16 files |
| Type checking                        |                        Pass |
| Lint                                 |          Pass with warnings |
| Production import cycles             |                           0 |
| Effect service modules               |                          28 |
| Direct production `JSON.parse` calls |                           0 |
| Explicit production `any` types      |                     0 found |

The test count comes from the repository commands run during this audit. No development server,
live Pi test, production process, remote service, or production database was touched.

## Reports

1. [System map](01-system-map.md)
2. [Runtime and delivery reliability](02-runtime-and-delivery.md)
3. [Platform architecture](03-platforms.md)
4. [Persistence and configuration](04-persistence-and-configuration.md)
5. [Maintainability and testing](05-maintainability-and-testing.md)
6. [Security and operations](06-security-and-operations.md)
7. [Prioritized roadmap](07-roadmap.md)
8. [Outcomes and decisions](08-outcomes-and-decisions.md)

## Claim labels

- **Observed** means the claim comes directly from source, configuration, tests, or command output.
- **Inferred risk** means the source permits a failure mode that the audit did not reproduce against a live platform.
- **Recommendation** means a proposed change, not a statement about current behavior.

## Scope limits

This audit covers the repository at the revision above. It does not assess live platform settings,
Supervisor configuration, reverse-proxy logs, filesystem backup policy, real model latency, or
branch-protection rules that may exist outside the repository.
