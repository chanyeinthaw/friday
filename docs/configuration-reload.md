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
without per-guild registration. It responds ephemerally:

- Non-admins receive an authorization failure.
- Unknown subcommands receive usage guidance.
- Success reports the new snapshot version.

### CLI

```
friday config reload
```

The CLI sends a single structured request over a local Unix control socket at
`$FRIDAY_HOME/friday.sock` (permissions `0600`, owner-only). There is no remote
control API. The socket:

- is created by the running Friday process and removed on shutdown
- replaces a stale socket file left by a killed process
- refuses to start when another live Friday already owns the socket
- returns structured outcomes: `{ ok: true, version }` on success and
  `{ ok: false, reason, detail }` on failure

CLI configuration commands that write SQLite (`platform invocation set`,
`platform system-channel set/reset`) take effect on the next reload.
