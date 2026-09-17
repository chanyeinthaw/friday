# 08. Outcomes and decisions

## Closure

The architecture audit closed on 2026-09-18 at revision `55e6e69`. The original findings remain a
snapshot of revision `d2e5556`; this document records what happened afterward.

The audit confirmed that Friday's existing architecture was sound. Work focused on runtime
reliability and modules with several independent reasons to change. No framework, database, or
platform rewrite was undertaken.

## Implemented work

| PR  | Change                                       | Result                                                                    |
| --- | -------------------------------------------- | ------------------------------------------------------------------------- |
| #55 | Release chat callbacks after turn dispatch   | Model completion no longer holds the inbound platform callback open       |
| #56 | Interrupt orphaned turns after restart       | Persisted pending and running turns reach an honest terminal state        |
| #57 | Verify pull requests                         | Pull requests run the repository verification command                     |
| #58 | Run migrations once per database scope       | SQL-backed services no longer initiate migrations independently           |
| #59 | Split CLI command families                   | Parsing, rendering, and handlers are organized by command family          |
| #60 | Extract platform connection runtime builders | Discord and Slack connection construction left their live composition     |
| #61 | Make platform capabilities explicit          | Unsupported optional behavior is visible instead of succeeding as a no-op |
| #62 | Split task use cases                         | The public task service now composes focused lifecycle and query modules  |

PR #55 shipped in `v0.0.0-nightly.34`. PRs #56 through #62 are included in the next release after
this closure record.

## Deferred decisions

### Durable outbound delivery

A SQLite delivery queue would recover final publications after platform failure or process exit.
That guarantee does not justify its state machine, retry policy, and duplicate-delivery semantics
for the current deployment. Reconsider only after a real missed-delivery problem.

### Migration ledger

Migration execution now has one owner, while existing defensive schema reconciliation remains.
Stable recorded migration IDs are deferred until Friday needs ordered data transformations that
schema inspection cannot represent clearly.

## Not planned

- Configuration mutations keep their documented mix of live and restart-required behavior. Typed
  activation outcomes would restate an intentional operational choice.
- Document content remains separate from SQLite metadata. Documents are temporary, so generation
  storage and coordinated backup add complexity without enough value.
- Detached title and task-completion work remains process-local. Application-owned background
  draining was explicitly discarded.
- The repository does not need a root maintainer README at its current size.
- CI remains pull-request-only. Main-branch verification and a representative binary build were
  intentionally excluded from the CI change.

## Accepted or external concerns

- The existing lint-warning backlog remains. `pnpm verify` still reports it without making new
  warnings a separate failure gate.
- Raw HTML sanitization remains custom and protected by the existing restrictive CSP. No broader
  raw-HTML feature work is planned.
- Document files do not require backup because they are temporary.
- Log rotation, SQLite backup policy, and reverse-proxy request logging belong to the deployment
  environment and were not verified by this source audit.
- Small platform connection SQL helpers should be extracted only if duplication grows.
- Discord and Slack should remain parallel platform-specific implementations rather than a generic
  plugin framework.

## Preserved constraints

- Keep SQLite and Effect.
- Keep platform payloads outside the conversation domain.
- Keep schema decoding at persistence and transport boundaries.
- Keep the process single-node until observed load or reliability requirements demand otherwise.
- Prefer focused failure-mode tests over a repository-wide coverage target.
