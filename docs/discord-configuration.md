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
only changes on restart. Stored connection fields can be edited with
`connection update` (name, application ID, public key, bot token environment
variable, global-mention behavior); unspecified fields are preserved,
application IDs stay unique across connections, and the bot token itself is
never stored — only the environment variable name. Any applied change requires
a restart. Setting or resetting the activity-description flag is the one
exception: the running process watches that flag and applies it live within
about a second.

## Guilds

The guild is the first-class enabled operational boundary. A guild that is not
configured, or configured with `enabled: false`, never receives any Friday
activity: the Discord adapter drops its messages before any thread is created
or reply is posted.

Each configured guild carries guild-wide defaults:

- `invocation.defaultMode` — `mention-only` or `all-messages`
- `users` (optional) — the guild-wide user permission default; when absent it
  inherits the connection-wide user policy
- `channelScope` (optional) — the guild-wide channel scope; when absent it is
  `all`, so every channel of the guild admits Friday

The channel scope controls which channels admit Friday at all. It uses the same
policy shape as the user policies: `all`, `allow=<channel-id>[,...]`, or
`deny=<channel-id>[,...]`.

## Channels

A channel entry overrides guild defaults for one channel. Every field is
optional, so a row only carries the overrides it needs:

- `invocationMode` — override of the guild invocation default
- `users` — override of the guild user permission default. A configured
  channel policy replaces the guild policy completely; allow-list IDs are not
  merged. Repeat any guild-allowed IDs you still want to permit.
- `replyMode` — `reply-in-thread` (the default) or `reply-in-channel`

Channel entries are overrides only. They never grant admission: a channel that
the guild channel scope does not admit stays closed even when it carries an
entry. Scope lives on the guild (`channelScope`), overrides live on the channel
rows — the two are configured with separate commands and must not be confused.

## Resolution rules

For a message in an enabled guild:

- **Channel admission**: the guild's channel scope decides first. A channel
  outside the scope (`allow` without the channel, `deny` with it) resolves to no
  policy at all: Friday does not invoke, does not create threads, and does not
  reply there. Messages already inside a thread resolve from the parent channel,
  so a thread rooted in a channel that loses admission goes quiet.
- **Invocation**: channel override → guild default. `mention-only` invokes on
  mentions (user, configured role, or global per the connection topology);
  `all-messages` invokes on every message.
- **Permissions**: channel users override → guild users default → connection
  user policy. A channel `users` override replaces the inherited policy
  completely, including its subject IDs. The resolved policy gates the message
  at the adapter boundary, before any externally visible action.
- **Reply mode**: channel override → `reply-in-thread`.

Direct messages have no guild: they resolve against the connection-wide user
policy and always invoke; the guild channel scope never applies to them.

Messages that already live in a thread (user-created or previously created by
Friday) always stay in that thread; their policy resolves from the parent
channel. Reply-in-channel therefore never splits an existing thread — it only
determines where the first reply to a channel message goes, subject to adaptive
thread routing below.

## Adaptive thread routing

Top-level messages in `reply-in-channel` channels use adaptive thread routing.
After projection and channel-history enrichment but before the agent turn,
Friday asks the configured utility model whether the message should stay
in-channel or move to a new native Discord thread.

- The decision is conservative and schema-validated: `keep-channel` with
  `channel-appropriate`, or `create-thread` with `explicit-request` (the user
  asked for a thread) or `thread-beneficial` (substantial focused multi-step
  work). Ambiguous, short, casual, acknowledgement, lookup, and status messages
  stay in-channel.
- Messages already in native threads never route, including manually created
  thread starters repaired by projection.
- A routed message keeps its source identity, channel identity, attribution,
  and bounded parent-channel context; only the conversation binding moves to
  the new thread. The new thread becomes a distinct Friday channel thread with
  its own runtime. Working and final output target the native thread; the
  parent channel receives no notice.
- Model, auth, decision-timeout, validation, and native-thread-creation
  failures log and continue in the parent channel without dropping the
  message. Native thread creation is a single awaited attempt with no retry,
  no client-side timeout, and no persistent routing records. The Discord POST
  cannot be cancelled server-side, so routing waits for its result: a slow
  Discord API delays the reply instead of answering in the parent while the
  same creation later orphans a native thread.

## CLI

Guild configuration is stored in SQLite and managed through direct CLI
administration. The commands work while Friday is not running. After an actual
guild or channel write, the CLI asks a running Friday process to reload through
its local control socket. Repeated identical setter commands report `unchanged`
and do not write or reload. A successful response reports the new snapshot
version without claiming that the specific mutation was applied live. Guild and
channel policy takes effect live only when that Discord connection is already
resident; connection topology remains pinned to startup. If Friday is offline,
the durable change applies on its next startup. A structured reload rejection is
reported separately from timeouts, malformed or oversized responses, and
post-send disconnects, where live application cannot be confirmed.

```
friday config discord connection add <connection-id> --name <name>
    --application-id <snowflake> --public-key <64-hex-digits>
    --bot-token-env <environment-variable-name> [--respond-to-global-mentions]
friday config discord connection update <connection-id> [--name <name>]
    [--application-id <snowflake>] [--public-key <64-hex-digits>]
    [--bot-token-env <environment-variable-name>]
    [--respond-to-global-mentions|--no-respond-to-global-mentions]
friday config discord connection remove <connection-id> --yes
friday config discord connection enable <connection-id>
friday config discord connection disable <connection-id>
friday config discord connection get <connection-id> [--json]
friday config discord connection list [--json]
friday config discord guild enable <connection-id> <guild-id>
friday config discord guild disable <connection-id> <guild-id>
friday config discord guild remove <connection-id> <guild-id> --yes
friday config discord guild list <connection-id> [--json]
friday config discord guild set-invocation <connection-id> <guild-id> <mention-only|all-messages>
friday config discord guild set-users <connection-id> <guild-id> <all|allow=<id>[,...]|deny=<id>[,...]>
friday config discord guild set-channels <connection-id> <guild-id> <all|allow=<id>[,...]|deny=<id>[,...]>
friday config discord guild channel set <connection-id> <guild-id> <channel-id>
    [--invocation <mention-only|all-messages>] [--users <policy>]
    [--reply-in-thread|--reply-in-channel]
friday config discord guild channel reset <connection-id> <guild-id> <channel-id>
friday config discord activity-description set <connection-id>
friday config discord activity-description reset <connection-id>
```

Connection add stores the bot token environment variable name, never the token.
Application IDs are unique across Discord connections. Add and remove update the
platform and Discord connection tables in one transaction. Remove requires
`--yes` because it also deletes the connection's guild and channel configuration.
Add, remove, update, enable, and disable report idempotent outcomes (update
reports `unchanged` when nothing differs) and require a Friday restart. Get and
list only read stored configuration.

Guild removal also deletes the guild's channel overrides, so it requires `--yes`
before it dispatches. The old `config discord guild invocation set` and
`config discord guild users set` forms and the old
`platform activity-description set|reset` form were removed and are rejected
with a pointer to their replacements.

Activity-description changes apply live: the running Discord adapter watches
the stored flag on a ~1 second loop, so `set` and `reset` take effect without a
reload or restart. `reset` additionally clears Friday-owned description text.

Guild, channel, and user IDs are validated as Discord snowflakes. Permission
policies are `all`, `allow=<id>[,<id>...]`, or `deny=<id>[,<id>...]`.
`guild set-users` replaces the guild-wide user permission default and
`guild set-channels` replaces the guild-wide channel scope; both affect every
channel without its own override. Policy subject IDs are compared as normalized
sets, so order and duplicate input do not cause a write. `channel set` upserts
the per-channel overrides row and only touches the flags given, so a channel can
carry a single override. It never changes which channels admit Friday. `channel
reset` removes the row entirely.

## CLI help

`friday --help` renders the full command listing from the same typed command
tree the parser uses. Execution uses a separate switch over the parsed action
union. The switch has a `never` default, and the operation contract is typed,
so adding an action without an execution case fails typechecking. Every command
prefix accepts `--help`:
`friday config discord guild --help` lists the guild subcommands, and
`friday config discord guild set-users --help` prints that command's exact
usage. The tree is the source of parsing and help metadata. The exhaustive
action switch is the source of execution behavior.

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
