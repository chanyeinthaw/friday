# Slack configuration

Friday's Slack support uses Socket Mode only through the official
`@chat-adapter/slack` adapter (`4.40.0` with `chat@4.40.0`). There is no
webhook/public HTTP transport: Friday holds one outbound WebSocket per
connection and receives workspace events over it, including Agent Sessions
lifecycle events.

## Slack app creation

Create the app at <https://api.slack.com/apps> (From scratch, name it
whatever you like, pick Chan's workspace), then configure it as follows.

### Agent/AI setting

- Open **Features → Agents & AI Apps** (Slack's Agent messaging experience,
  `agent_view`) and enable it. Friday runs with `agentView: true`, which
  keeps Agent Sessions events, explicit session titles, and suggested prompts
  available over Socket Mode. Friday never sets session working status, so
  Friday runs show no processing indicator or Stop button. Slack deprecated
  `assistant_view`; it retires in February 2027 and Friday does not use it.

### Socket Mode settings

- Open **Settings → Socket Mode** and enable Socket Mode. Slack prompts for
  an app-level token name; creating it is covered below.

### Event subscriptions

- Open **Features → Event Subscriptions** and enable events.
- Subscribe to these bot events:
  - `app_mention` — direct bot mentions in channels.
  - `message.channels` — channel messages (thread continuation and
    mention detection).
  - `message.groups` — private-channel messages.
  - `message.im` — direct messages.
  - `message.mpim` — group direct messages.
  - `assistant_thread_started` — assistant/agent thread opens (suggested
    prompts apply here; Friday logs without creating threads).
  - `assistant_thread_context_changed` — user navigates with the assistant
    panel open (logged only).
  - `agent_session_stopped`. Slack may still emit this when a session stops.
    Friday logs it only. The Pi turn continues and Friday sets no status
    (see limitations).
  - `agent_session_title_changed` — user renames a session (logged only).
  - `app_home_opened` — Home/Messages tab opens (Messages-tab prompts apply;
    logged only).
  - `app_context_changed` — active-view changes (normalized entities logged
    only; never changes Friday workspaces).
  - `member_joined_channel` — membership only (never invokes Friday).
- Friday ignores everything else, including `@channel`, `@here`, and
  user-group mentions, which never invoke it.

### Bot scopes

Under **Features → OAuth & Permissions → Scopes → Bot Token Scopes**, add:

- `app_mentions:read` — receive mention events.
- `channels:history`, `groups:history`, `im:history`, `mpim:history` —
  read recent messages for context and search.
- `channels:read`, `groups:read`, `im:read`, `mpim:read` — read channel
  metadata for bootstrap context.
- `chat:write` — post replies and working messages (native `markdown_text`).
- `assistant:write`. Covers explicit session rename (`agents.sessions.rename`),
  suggested prompts, and Agent Sessions events. Required for the Agent
  experience. Friday does not call `agents.sessions.setStatus`.
- `reactions:write` — acknowledge messages with the eyes reaction.
- `users:read` — resolve author display info (optional but recommended).

### App-level token scope

Under **Settings → Basic Information → App-Level Tokens**, generate a token
with exactly this scope:

- `connections:write` — required for Socket Mode. The token starts with
  `xapp-`.

### Installation

- Open **Settings → Install App** and install the app to the workspace.
  Note the Bot User OAuth Token (starts with `xoxb-`).

### Invitation and channel membership

- Invite the bot user to every channel Friday should serve (`/invite @Friday`
  or the channel's member list). Friday cannot read or reply in channels it
  has not joined, and unjoined channels stay silent.
- For direct messages, any workspace member can open a DM with the bot user.

## Friday CLI configuration

Tokens are never stored: configuration records only environment variable
names, and Friday resolves the secrets at load time. Export both before
starting Friday:

```
export FRIDAY_SLACK_BOT_TOKEN=xoxb-...
export FRIDAY_SLACK_APP_TOKEN=xapp-...
```

Connections are the lifecycle boundary: Socket Mode resources are built once
per process, so connection topology (identity, credentials) is pinned to the
startup snapshot and only changes on restart. Access policy, reply modes, and
channel overrides reload live.

```
friday config slack connection add <connection-id> --name <name>
    --bot-token-env FRIDAY_SLACK_BOT_TOKEN --app-token-env FRIDAY_SLACK_APP_TOKEN
    [--reply-in-thread|--reply-in-channel]
friday config slack connection update <connection-id> [--name <name>]
    [--bot-token-env <env-name>] [--app-token-env <env-name>]
    [--reply-in-thread|--reply-in-channel]
friday config slack connection remove <connection-id> --yes
friday config slack connection enable <connection-id>
friday config slack connection disable <connection-id>
friday config slack connection get <connection-id> [--json]
friday config slack connection list [--json]
friday config slack access set-users <connection-id> <all|allow=<id>[,...]|deny=<id>[,...]>
friday config slack access set-channels <connection-id> <all|allow=<id>[,...]|deny=<id>[,...]>
friday config slack access set-workspaces <connection-id> <all|allow=<id>[,...]|deny=<id>[,...]>
friday config slack channel set <connection-id> <channel-id> [--reply-in-thread|--reply-in-channel]
    [--invocation <mention-only|all-messages>]
friday config slack channel reset <connection-id> <channel-id>
```

Access policies use the same shape as elsewhere: `all`,
`allow=<id>[,...]`, or `deny=<id>[,...]`. Admission is fail-closed: a
workspace outside the workspace scope or a channel outside the channel scope
never invokes Friday and never gains thread or reply behavior. Channel rows
only override reply and invocation behavior; they never grant admission.

## Reply modes

Each connection has a default reply mode, overridable per channel:

- `reply-in-thread` (the default) — the platform thread is the agent
  thread. The root message timestamp binds the conversation, and replies
  stay in that thread.
- `reply-in-channel` — the platform channel is the agent thread. Top-level
  messages use adaptive thread routing: Friday asks the configured utility
  model whether the message should stay in-channel or move to a new
  platform thread rooted at the invoking message, which becomes a distinct
  agent thread. Routing failures stay in the parent channel.

Friday's canonical scope (`slack:{team}:{channel}[:{threadTs}]`) stays the
persistence identity; the adapter's team-less transport ids
(`slack:{channel}[:{threadTs}]`) are reconciled explicitly at the boundary
and never adopted. Top-level adapter threads collapse to the shared channel
root; threaded messages keep their root timestamp. DMs, routed threads, and
bound-thread continuation all preserve these semantics.

Messages already inside a thread always stay in that thread.

## Invocation modes

Each channel invokes on direct bot mentions by default (`mention-only`); a
channel configured with `all-messages` also invokes on top-level channel
messages without a mention. Thread replies in an `all-messages` channel
still need a mention or an ongoing Friday thread. `@channel`, `@here`, and
user-group mentions never count as direct mentions, but in an `all-messages`
channel the containing message invokes because of the channel mode, not the
mention. Bound-thread continuation and direct messages invoke without a
mention in both modes.

## Agent UI mapping

- Progress (`begin/update/finalize`) posts plain working messages with native
  markdown. Friday posts `Thinking...`, edits the same message for tool
  activity, edits it into the answer when it stays latest, and deletes and
  reposts fresh when another message overtakes it. Empty output deletes the
  working message. Friday sets no session status.
- Generated conversation titles mirror to the Slack agent session via
  `setAssistantTitle` (`agents.sessions.rename`, 80 chars) for threads only;
  channel roots stay untitled. Automatic adapter titling is disabled
  (`sessionTitle: false`).
- Suggested prompts are pinned on assistant/agent thread opens and
  Messages-tab opens (`What can you do?`, `Summarize this channel`).
- Native streaming (`chatStream`) is DM-only in the adapter (channels fall
  back to post-and-edit); Friday uses post-and-edit consistently so both
  reply modes behave identically, with markdown rendered natively.
- `app_context_changed` entities and `app_home_opened` context are logged
  only and never change Friday workspaces, persistence, steering, tasks,
  routing, access, history, or channel-scoped behavior.

## Current limitations

- Image and file ingestion is deferred: attached files appear to the agent
  as a concise `[Slack attachment unsupported: name (type)]` notice.
- No Slack slash commands (`/friday`, `/harness`, or others).
- No global presence. Task activity stays inside the conversation as visible
  messages only. Friday sets no per-thread session status.
- No native Stop button from Friday. Friday never sets processing status, so
  its runs show no Stop button. If Slack emits `agent_session_stopped` on its
  own, Friday logs it only and the Pi turn continues. Native cancellation
  stays unsupported.
- No webhook/HTTP transport; Socket Mode connections only.
