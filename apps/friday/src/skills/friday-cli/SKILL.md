---
name: friday-cli
description: Inspect and manage Friday through its installed CLI, including configuration, models, Discord access, documents, worktrees, and cleanup.
---

# Friday CLI

Use Friday's CLI for Friday-owned state. Do not edit `friday.sqlite` or its generated files directly.

## Find the CLI

The active binary normally lives under `FRIDAY_HOME`:

```sh
FRIDAY_BIN="${FRIDAY_HOME:-$HOME/.friday}/bin/friday"
test -x "$FRIDAY_BIN" || FRIDAY_BIN="$(command -v friday)"
"$FRIDAY_BIN" --version
```

Do not run the binary without arguments while inspecting it. No arguments starts Friday.

The command set changes between nightly releases. Read current help instead of relying on remembered syntax:

```sh
"$FRIDAY_BIN" --help
"$FRIDAY_BIN" config --help
"$FRIDAY_BIN" config discord guild channel set --help
```

`--help` may follow a command path. There is no `help` subcommand.

## Read state first

Prefer `--json` for results that will be parsed or compared:

```sh
"$FRIDAY_BIN" config model list --json
"$FRIDAY_BIN" config profile list --json
"$FRIDAY_BIN" config admin discord list --json
"$FRIDAY_BIN" config identity get --json
"$FRIDAY_BIN" config root-user list --json
"$FRIDAY_BIN" config discord connection list --json
"$FRIDAY_BIN" config discord guild list <connection-id> --json
"$FRIDAY_BIN" model list --available --json
"$FRIDAY_BIN" worktree list --json
"$FRIDAY_BIN" document list --json
"$FRIDAY_BIN" workspace cleanup list --json
```

Some getters represent a missing value as `null` or human-readable text while still exiting successfully. Check the output before treating it as a populated result.

Configuration queries open `$FRIDAY_HOME/friday.sqlite`. They may ensure or migrate the schema even though they do not change the requested setting.

## Configuration changes

Inspect the exact leaf help before a write. Then read the value back.

Model and profile writes reload their configuration automatically:

```sh
"$FRIDAY_BIN" config model set utility \
  --provider <provider> \
  --model-id <model-id> \
  --thinking <off|minimal|low|medium|high|xhigh|max>

"$FRIDAY_BIN" config profile update <name> \
  --provider <provider> \
  --model-id <model-id> \
  --thinking <level>
```

Guild and channel writes need an explicit live reload:

```sh
"$FRIDAY_BIN" config discord guild set-users \
  <connection-id> <guild-id> 'allow=<user-id>[,<user-id>...]'

"$FRIDAY_BIN" config reload
```

Connection topology and Discord administrator changes need a process restart. This includes adding, removing, enabling, disabling, or updating a connection. Do not restart Friday inline. Use the `friday-update` skill's restart procedure.

Root users and Discord administrators are different:

- `config root-user` grants Friday root-user authority within a platform scope.
- `config admin discord` manages the Discord administrator list used at startup.

## Discord policy rules

Permission policies are:

```text
all
allow=<id>[,<id>...]
deny=<id>[,<id>...]
```

The guild channel policy decides which channels admit Friday. A channel override cannot admit a channel excluded by that policy.

A channel `--users` policy replaces the guild user policy. It does not merge with it. Repeat any guild-level allowed IDs that should remain allowed in that channel.

Channel overrides can change invocation, users, and reply mode. Omitted flags preserve their current values. `channel reset` removes all overrides for that channel.

## Other operations

`worktree ensure` may clone or fetch a repository and create a worktree. Set the workspace explicitly when the current directory is not the owning channel workspace:

```sh
"$FRIDAY_BIN" worktree ensure <repository-url> \
  --ref <ref> \
  --workspace <channel-workspace> \
  --json
```

Document URLs contain secret access keys. Do not print them in logs. `document get` and `document list` omit URLs. Use `document url` only when the link must be sent to the intended reader.

`workspace cleanup apply` deletes resources. Run it only for an approved proposal ID and from the owning channel workspace. Use `workspace cleanup list --json` to inspect proposals first.

## Boundaries

- Never expose bot tokens, model credentials, document access keys, or full secret URLs.
- Do not guess IDs or command names. Read current state and leaf help.
- Do not use `config reload` as a read-only probe. It changes the running configuration snapshot.
- Do not apply cleanup, remove profiles, remove guilds, or remove connections without explicit approval.
- The CLI does not discover Discord guild or channel IDs and does not create cleanup proposals.
