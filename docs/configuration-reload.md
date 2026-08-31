# Configuration reload

Friday reads its Tier 1 configuration from SQLite into a validated, versioned
in-memory snapshot. The running process never queries SQLite for configuration
on the message path and never polls the database; instead, an explicit reload
operation loads and validates the complete configuration and atomically swaps
it into the running snapshot.

## What reload applies

- Discord access policies (users, channels, guilds) — enforced per message
- Channel invocation modes and defaults — enforced per message
- Direct system-management channels — enforced per message
- `agent.recentMessageCount` — read when loading new-conversation context
- Primary model defaults — applied to newly bootstrapped threads
- Subagent profiles — applied to newly opened runtimes and new tasks

Active turns are never interrupted: open runtimes keep their resolved sessions,
and reload does not evict or restart any work.

## What stays restart-based

Discord resources are built once per process, so the following are pinned to
the startup snapshot and ignored by reload:

- Discord connections (adding, removing, enabling, disabling)
- Credentials (bot token environment variable, application ID, public key)
- Mention role IDs and global-mention behavior
- Activity-description publication
- The admin allow-list (see below)

Changes to these require a Friday restart.

## Admin allow-list

`/friday reload` is authorized by exact match against stable Discord user IDs
stored in the `admin_discord_users` table:

```sql
INSERT INTO admin_discord_users (user_id, created_at)
VALUES ('123456789012345678', CURRENT_TIMESTAMP);
```

The list is read into the snapshot at startup and pinned across reloads, so a
database edit can never lock administrators out of a running process. Managing
the list is a restart-based operation.

## How to reload

### Discord application command

`/friday reload` is registered as a global application command for the
application, so it is available in every guild (including newly invited ones)
without per-guild registration. Registration is idempotent and single-command:
the existing global commands are listed first, then `/friday` is created via
POST when missing or updated via PATCH by command ID when present — never a
bulk overwrite, so unrelated commands and other deployments are untouched. The
command responds ephemerally:

- Non-admins receive an authorization failure.
- Unknown subcommands receive usage guidance.
- Success reports the new snapshot version.

### CLI

```
friday config reload
```

The CLI sends a single structured request over a local Unix control socket at
`$FRIDAY_HOME/friday.sock` (permissions `0600`, owner-only, inside an owner-only
`$FRIDAY_HOME`). There is no remote control API. The socket and its lifecycle
lock:

- are created by the running Friday process and removed on shutdown
- are guarded by an exclusive lock directory (`friday.sock.lock`): exactly one
  Friday process can start serving; a lock whose owner process is dead is
  recovered safely
- replace a stale socket file left by a killed process
- refuse to start when another live Friday already owns the socket
- accept one request per connection, reject oversized (over 4 KB) or
  trailing/multiple requests, and drop idle or stalled clients after a timeout
- are destroyed together with live connections on shutdown so finalization
  cannot hang
- return structured outcomes: `{ ok: true, version }` on success and
  `{ ok: false, reason, detail }` on failure
- are requested under a client-side deadline (10 seconds) and response size
  cap, so an unresponsive or misbehaving server fails fast with a typed error

CLI configuration commands that write SQLite (`platform invocation set`,
`platform system-channel set/reset`) take effect on the next reload.
