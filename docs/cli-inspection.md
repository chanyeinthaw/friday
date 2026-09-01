# CLI worktree and workspace-cleanup inspection

Friday exposes two read-only listing commands for inspecting persisted and
current repository state. Both are plain reads: they never mutate state and
never create or remove anything. Run `friday --help` or add `--help` to any
command prefix for the authoritative command and usage listing.

## `friday worktree list [--json]`

Lists the repository worktrees registered with Friday's repository caches
under `$FRIDAY_HOME/repositories`. Discovery is grounded in git's own worktree
registry for those persisted caches — the same registry `worktree ensure`,
isolated task worktrees, and cleanup removal operate on. The command never
scans the file system for arbitrary git repositories, so it cannot misreport
unrelated clones as Friday-managed worktrees.

Each entry reports:

- `url` — the remote URL of the repository cache the worktree was created from
- `path` — the absolute worktree path as registered with git; the directory may
  no longer exist on disk
- `branch` — the checked-out branch, or `null` for a detached head
- `head` — the concrete head commit
- `prunable` — true when git reports the worktree directory as missing

Human output groups entries by repository and shows one line per worktree; a
missing directory is surfaced as `(missing on disk)` rather than hidden, so
stale registrations are visible before a cleanup proposal is applied. With
`--json`, the command prints a JSON array of the entries above. Worktrees
created from a user's own clone (outside Friday's caches) are intentionally
not listed: Friday has no persisted record of them, and guessing would be
misleading.

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

Listing does not validate a proposal against the live file system; freshness
is enforced at apply time, where a changed workspace or worktree fails
validation and marks the proposal stale.
