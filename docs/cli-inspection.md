# CLI worktree and workspace-cleanup inspection

Friday exposes two read-only listing commands for inspecting persisted and
current repository state. Both are plain reads: they never mutate state and
never create or remove anything. Run `friday --help` or add `--help` to any
command prefix for the authoritative command and usage listing.

## `friday worktree list [--json]`

Lists the repository worktrees Friday created or explicitly adopted, using a
persisted registry as the source of truth for that lifecycle ownership. The registry lives at
`$FRIDAY_HOME/repositories/worktrees.json` and is written only by Friday's own
worktree lifecycle operations: `worktree ensure` registers the worktree it
creates or adopts, isolated task worktrees register at creation, and cleanup
removal unregisters the entry it removed. Because the registry is the only source of entries, the command never scans
the file system for arbitrary git repositories. An entry may be Friday-created
or explicitly adopted after exact validation.

For every registered entry, the current branch, head, and prunable state are
read from git's own worktree registry at the entry's recorded common
directory. Entries whose owning repository is gone, was pruned, or whose
directory was removed out-of-band are still listed as missing on disk, so
stale registrations are visible before a cleanup proposal is applied.

Each entry reports:

- `url` — the remote URL Friday used when creating or adopting the worktree
- `commonDirectory` — the git common directory that owns the registration
  (a Friday bare repository cache, or the primary repository for isolated
  task worktrees)
- `path` — the absolute worktree path as registered with git; the directory
  may no longer exist on disk
- `branch` — the checked-out branch, or `null` for a detached head
- `head` — the concrete head commit
- `prunable` — true when the worktree is missing or deregistered in git

Human output groups entries under their owning repository URL, one line per
worktree; a missing directory is surfaced as `(missing on disk)` rather than
hidden. With `--json`, the command prints a JSON array of the entries above.

### Pre-registry worktrees

A missing registry means Friday cannot prove ownership of existing worktrees.
`worktree list` therefore returns no entries until a Friday lifecycle operation
registers an exact worktree path. This is deliberately conservative. A cache
under `$FRIDAY_HOME/repositories` is not enough evidence by itself because an
operator or another tool may have placed it there.

`worktree ensure` may adopt an existing destination only after its exact path
and origin remote match the request. Isolated task creation is stricter: the
destination must be registered in the requested primary repository's Git
common directory and checked out on the exact deterministic
`friday/task/<id>` branch. Validation happens before Friday registers or
mutates the destination.

These guarantees begin with registry-aware Friday versions. Older Friday
versions did not persist ownership metadata, so the absence of an entry cannot
prove who created a pre-registry worktree.

Registry read-modify-write operations keep the in-process semaphore and also
hold an inter-process lock directory next to the registry. Each holder writes a
random owner token with its PID, process start metadata, and diagnostic start
time. Contenders wait and retry. Friday reclaims a lock only when it can prove
the recorded process is dead, or on Linux when the PID now belongs to a
different process. Age alone never makes a live lock stale. Release and stale
recovery first move the matching owner token out of the lock directory, then
remove the empty directory, so they cannot delete a successor's lock. Lock
waiting is bounded to 10 seconds. The final document is replaced by atomic
rename, so readers do not see a partly written file. A malformed registry is a
typed error rather than silently discarded state.

## `friday workspace cleanup list [--json]`

Lists every recorded workspace cleanup proposal from the persisted
`workspace_cleanup_proposals` table, most recently created first, together
with each proposal's resource snapshots. It complements
`workspace cleanup apply`: apply executes one approved proposal from its
owning workspace, while `list` shows all recorded proposals, including pending, failed, applied, and stale, from
anywhere.

Human output shows one block per proposal: id, status, the recorded summary
(worktree count, uncommitted-file count, estimated size), the owning workspace
path, and each resource with its branch, size, and removal progress. With `--json`, the command
prints a JSON array of full proposal records (the same shape
`workspace cleanup apply --json` returns for a single proposal, including the
`resources` snapshots).

Listing does not validate a proposal against the live file system. Apply first
validates every remaining resource. A changed workspace or worktree marks the
proposal `stale` before any new deletion starts.

Cleanup is not an atomic filesystem transaction. Each resource starts as
`pending`. Apply persists `removing` before it changes Git, the filesystem, or
the registry, then persists `removed` after reconciliation completes. If the
process crashes after external deletion, the next apply treats `removing` as
durable intent. It checks the worktree and branch, prunes Git state, and removes
the registry entry before marking the resource `removed`. A failed proposal
keeps `pending`, `removing`, and `removed` progress honestly and can be applied
again.

SQLite enforces one `pending` or `failed` cleanup proposal per thread with a
partial unique index. Concurrent propose calls return that one active proposal.
Migration keeps the newest active proposal by creation time and proposal id,
then marks older active duplicates `stale` before creating the index.
