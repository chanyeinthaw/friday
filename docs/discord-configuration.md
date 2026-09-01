# Discord configuration

Friday's Discord configuration has three levels with distinct jobs.

## Connections

A connection identifies one Discord bot: its credentials (bot token environment
variable, application ID, public key), name, mention roles, global-mention
behavior, and activity-description publication. The bot token itself is never
stored; configuration only records the environment variable name and Friday
resolves the secret at load time.

Connections are the lifecycle boundary: Discord gateway resources are built
once per process, so connection topology is pinned to the startup snapshot and
only changes on restart.

## Guilds

The guild is the first-class enabled operational boundary. A guild that is not
configured, or configured with `enabled: false`, never receives any Friday
activity: the Discord adapter drops its messages before any thread is created
or reply is posted.

Each configured guild carries guild-wide defaults:

- `invocation.defaultMode` — `mention-only` or `all-messages`
- `users` (optional) — the guild-wide user permission default; when absent it
  inherits the connection-wide user policy

## Channels

A channel entry overrides guild defaults for one channel. Every field is
optional, so a row only carries the overrides it needs:

- `invocationMode` — override of the guild invocation default
- `users` — override of the guild user permission default
- `replyMode` — `reply-in-thread` (the default) or `reply-in-channel`

## Resolution rules

For a message in an enabled guild:

- **Invocation**: channel override → guild default. `mention-only` invokes on
  mentions (user, configured role, or global per the connection topology);
  `all-messages` invokes on every message.
- **Permissions**: channel users override → guild users default → connection
  user policy. The resolved policy gates the message at the adapter boundary,
  before any externally visible action.
- **Reply mode**: channel override → `reply-in-thread`.

Direct messages have no guild: they resolve against the connection-wide user
policy and always invoke.

Messages that already live in a thread (user-created or previously created by
Friday) always stay in that thread; their policy resolves from the parent
channel. Reply-in-channel therefore never splits an existing thread — it only
determines where the first reply to a channel message goes.

## CLI

Guild configuration is stored in SQLite and managed through direct CLI
administration — the commands work while Friday is not running, and a running
Friday applies the changes on its next configuration reload
(`friday config reload` or `/friday reload`).

```
friday config discord connection add <connection-id> --name <name>
    --application-id <snowflake> --public-key <64-hex-digits>
    --bot-token-env <environment-variable-name> [--respond-to-global-mentions]
friday config discord connection remove <connection-id> --yes
friday config discord connection enable <connection-id>
friday config discord connection disable <connection-id>
friday config discord connection get <connection-id> [--json]
friday config discord connection list [--json]
friday config discord guild enable <connection-id> <guild-id>
friday config discord guild disable <connection-id> <guild-id>
friday config discord guild remove <connection-id> <guild-id>
friday config discord guild list <connection-id> [--json]
friday config discord guild invocation set <connection-id> <guild-id> <mention-only|all-messages>
friday config discord guild users set <connection-id> <guild-id> <all|allow=<id>[,...]|deny=<id>[,...]>
friday config discord guild channel set <connection-id> <guild-id> <channel-id>
    [--invocation <mention-only|all-messages>] [--users <policy>]
    [--reply-in-thread|--reply-in-channel]
friday config discord guild channel reset <connection-id> <guild-id> <channel-id>
```

Connection add stores the bot token environment variable name, never the token.
Application IDs are unique across Discord connections. Add and remove update the
platform and Discord connection tables in one transaction. Remove requires
`--yes` because it also deletes the connection's guild and channel configuration.
Add, remove, enable, and disable report idempotent outcomes and require a Friday
restart. Get and list only read stored configuration.

Guild, channel, and user IDs are validated as Discord snowflakes. Permission
policies are `all`, `allow=<id>[,<id>...]`, or `deny=<id>[,<id>...]`.
`channel set` upserts the row and only touches the flags given, so a channel
can carry a single override; `channel reset` removes the row entirely.

## Migration from connection-scoped configuration

Before guilds, Friday stored invocation defaults, channel invocation policies,
and system channels at the connection level. The migration
(`runMigrations`) converts that data one time, inside a single transaction:

- **Guild discovery**: guild IDs are taken only from real data — existing guild
  access subjects and the guild segment of persisted conversation bindings.
  The old guild access policy decides each discovered guild's `enabled` flag
  (`all` or no policy → enabled; `allow` → listed guilds; `deny` → unlisted
  guilds), and the connection invocation default becomes each guild's
  invocation default.
- **Channel overrides**: old channel invocation policies migrate under their
  observed guild; former system-management channels become
  `reply-in-channel` channel overrides. A channel recorded by both legacy
  features merges into one override row that keeps both semantics.
- **Fail-closed, no guesses**: when any legacy policy row cannot be mapped
  exactly — a channel whose guild cannot be observed from persisted data, a
  channel bound under more than one guild, or old channel access policies,
  which have no per-channel equivalent in the guild model — the migration
  aborts, rolls back, and Friday refuses to start. The error lists every
  offending row and the legacy tables are left untouched, so no policy is
  silently dropped or widened.

  Recovery has two paths, and both work while the refusal is in place:

  - **Record the equivalent guild configuration**: the guild configuration CLI
    commands keep working while Friday refuses to start, so the operator can
    `friday config discord guild enable <connection-id> <guild-id>` and
    `friday config discord guild channel set <connection-id> <guild-id>
<channel-id> ...` for each listed channel. The recorded row names the owning
    guild. Each explicit field supersedes only its matching legacy behavior:
    `invocation-mode` supersedes the old invocation policy and `reply-mode`
    supersedes old system-channel behavior. A users-only row supersedes neither.
    The migration merges unrelated legacy fields into the same row and never
    overwrites explicit values.
  - **Resolve the legacy rows directly**: rows with no guild-model equivalent —
    the channel access policies — have no recording path; edit or remove those
    legacy rows by hand (the tables are intact for exactly this purpose).

  Once the listed rows are resolved, restart Friday and the migration re-runs.

Friday checks all three legacy tables before migration. If only part of the
legacy schema exists, startup fails closed and names the present and missing
tables instead of skipping the remaining data.

Legacy tables are dropped only after the migration commits successfully. Existing conversations
keep working: their bindings already identify the conversation, and migrated
reply-in-channel bindings resolve to the same persisted threads.
