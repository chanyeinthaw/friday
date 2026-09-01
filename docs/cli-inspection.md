# CLI worktree and workspace-cleanup inspection

Friday exposes two read-only listing commands for inspecting persisted and
current repository state. Both are plain reads: they never mutate state and
never create or remove anything. Run `friday --help` or add `--help` to any
command prefix for the authoritative command and usage listing.

## `friday worktree list [--json]`

Lists the repository worktrees Friday manages, using a persisted registry as
the source of truth for what is Friday-managed. The registry lives at
`$FRIDAY_HOME/repositories/worktrees.json` and is written only by Friday's own
worktree lifecycle operations: `worktree ensure` registers the worktree it
creates or adopts, isolated task worktrees register at creation, and cleanup
removal unregisters the entry it removed. Because the registry is the only
source of entries, the command never scans the file system for arbitrary git
repositories and never claims caches or worktrees it did not create.

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

`worktree ensure` registers an existing matching worktree when it adopts it.
Task creation registers an existing matching isolated task worktree when it
reuses it. Cleanup removal updates registrations as it removes worktrees. The
registry writer uses an atomic rename, so listing never reads a partly written
file. A malformed registry is a typed error rather than silently discarded
state.

## `friday workspace cleanup list [--json]`

Lists every recorded workspace cleanup proposal from the persisted
`workspace_cleanup_proposals` table, most recently created first, together
with each proposal's resource snapshots. It complements
`workspace cleanup apply`: apply executes one approved proposal from its
owning workspace, while `list` shows all recorded proposals — pending, applied,
and stale — from anywhere.

Human output shows one block per proposal: id, status, the recorded summary
(worktree count, uncommitted-file count, estimated size), the owning workspace
path, and each resource with its branch and size. With `--json`, the command
prints a JSON array of full proposal records (the same shape
`workspace cleanup apply --json` returns for a single proposal, including the
`resources` snapshots).

Listing does not validate a proposal against the live file system. Freshness
is enforced at apply time: when the owning channel workspace or a recorded
worktree changed since the proposal was created, apply marks the proposal
`stale` transactionally and fails with a typed stale error, so it immediately
stops showing as pending in `workspace cleanup list`.
