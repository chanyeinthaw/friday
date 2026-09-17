# 04. Persistence and configuration

## Persistence model

Friday uses one SQLite file for several explicitly separated concerns:

```text
conversation       threads, turns, activities
configuration      models, identities, connections, guilds, policies
Chat SDK state     subscriptions, locks, cache, lists, queues
documents          metadata and serving configuration
workspace cleanup  proposals and resource snapshots
```

Large domain objects are schema-encoded into JSON payload columns, with selected lifecycle and
lookup fields duplicated as relational columns and indexes. This keeps domain decoding centralized
but weakens database-level constraints for fields that exist only inside JSON.

## What is working well

- SQL result rows are decoded through Effect Schema.
- Thread, turn, and activity sequence uniqueness is enforced with indexes.
- Compound lifecycle writes use transactions.
- Legacy Discord migration is fail-closed and preserves old tables when ownership is ambiguous.
- Configuration reload swaps one validated snapshot atomically and retains the old snapshot on
  failure.
- Workspace cleanup uses recorded snapshots and revalidation before deletion.
- Managed worktree locking handles dead owners, PID reuse, successor tokens, and cross-process
  contention, with integration coverage.

## Finding D1: migration ownership is repeated across services

Severity: medium
Claim: observed

Nine production services invoke `runMigrations()` during layer construction, including thread
persistence, documents, application config, identity, model config, root users, admins, and both
connection services. Some map migration errors into domain errors, while others call `Effect.orDie`.

The migrations are designed to be idempotent, so this works. It still makes schema readiness a
hidden side effect of unrelated service construction, repeats startup queries, and produces
different failure types depending on which service reaches the migration first.

### Recommendation

Create one `DatabaseReady` layer at the composition root:

```text
FridaySqliteLive
  -> runMigrations once
  -> DatabaseReady
  -> all SQL-backed services
```

Keep migration tests independent. Services should assume their declared database dependency is
ready rather than each becoming a migration entry point.

## Finding D2: there is no explicit migration ledger

Severity: medium
Claim: observed

Structural migration functions inspect SQLite shape and run `CREATE IF NOT EXISTS`, conditional
`ALTER`, table rebuilds, and one legacy data migration. There is no ordered migration table with a
recorded version or checksum.

This approach is defensible for a young single-user app, but `Migrations.ts` is already 1,060 lines.
As more data migrations arrive, schema inspection alone becomes harder to audit and makes it less
obvious which transformations ran on a particular installation.

### Recommendation

Keep the existing defensive checks, then add a small migration ledger for new migrations. Do not
rewrite old migrations. Record an ID, applied timestamp, and optional code version. Each new data
migration should be transactional and applied once.

## Finding D3: document content and metadata are not one atomic unit

Severity: medium
Claim: observed

[`Documents.save`](../../apps/friday/src/documents/Documents.ts) atomically renames the new content
file into place, then updates SQLite metadata. If the database write fails after the rename, the
filesystem contains the new content while SQLite may contain old metadata or no row. Removal does
the inverse: it deletes the row first and ignores file cleanup failure, which safely revokes access
but may leave orphaned files.

### Recommendation

The simplest robust option is storing bounded document content in SQLite with its metadata. If
filesystem storage must remain, add a content generation name to metadata, write a new immutable
file, commit the row to point at it, and garbage-collect unreferenced generations. Avoid pretending
that a database transaction can make a filesystem rename atomic.

## Finding D4: reload success has mixed application semantics

Severity: medium
Claim: observed

The config snapshot reloads models, profiles, identity, Discord guild policy, Slack access, reply
modes, and related values. Connection topology and Discord administrators stay pinned to startup.
The behavior is documented, but the shared reload result reports only a new version. It cannot say
whether the mutation that triggered reload became active.

### Recommendation

Have configuration mutations return activation semantics:

```ts
type ConfigurationMutationOutcome =
  | { readonly changed: false }
  | { readonly changed: true; readonly activation: 'live' }
  | { readonly changed: true; readonly activation: 'restart-required' }
```

Only request live reload for `activation: 'live'`. Print a restart instruction for topology and
admin changes. This removes the current gap between "reload succeeded" and "this change is active."

## Finding D5: configuration storage is split by platform with repeated mechanics

Severity: low
Claim: observed

Discord and Slack connection services separately implement list, get, add, remove, enable, disable,
update, row decoding, transaction mapping, and idempotent outcomes. Their actual platform fields and
cascade semantics differ, so a shared generic repository would likely make the code harder to read.

### Recommendation

Share only small SQL helpers for common `platform_connections` operations if duplication continues
to grow. Keep public platform service contracts separate.
