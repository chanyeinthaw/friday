# Friday

A personal AI assistant for Discord and Slack that delegates work to background agents while staying available for conversation.

## Why I built it

I wanted a bot I could talk to and ask to do things without waiting for a long task to finish before continuing the conversation. Friday's conversational agent owns the request, delegates sustained work, and brings the results back when the task finishes. I can send follow-up instructions while work continues.

## How it works

- In normal channels, the conversational agent answers directly when it already has enough information. Requests that need tools, investigation, external interaction, or sustained execution become background tasks.
- Tasks can be started, steered, cancelled, and inspected. Completion reports return to the originating conversation without the conversational agent polling for them.
- Conflicting coding tasks receive isolated Git worktrees. Workspace ownership is persisted and protected by cross-process locks.
- Pi-durable and SQLite persist inputs and execution checkpoints so interrupted generation can recover. Failed reply deliveries retry after restart.
- Optional conversation memory implements Victor Taelin's [OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), which builds on his [OptMem](https://github.com/VictorTaelin/OptMem) work. Hierarchical summaries and retrieval tools let the agent revisit original messages.

OptChat-enabled channels currently use a different execution policy: the agent can work directly with its tools and starts background tasks when requested. Normal channels use the delegation policy above.

Reply delivery is at least once. A crash after Discord or Slack accepts a reply but before Friday records delivery can produce a duplicate. Recovery does not guarantee exactly-once external actions.

## Build from source

The workspace requires Bun and pnpm. See [package.json](package.json) for the supported versions.

```sh
pnpm install --frozen-lockfile
pnpm build
./apps/friday/dist/friday --help
```

The build produces the Friday executable at `apps/friday/dist/friday`. Use the CLI help and the guides below to configure models and platform connections before starting the service.

## Configuration and implementation guides

- [Model selections and subagent profiles](docs/model-configuration.md)
- [Discord connections and access policies](docs/discord-configuration.md)
- [Slack connections and access policies](docs/slack-configuration.md)
- [Configuration reload](docs/configuration-reload.md)
- [Worktree and workspace inspection](docs/cli-inspection.md)
- [Pi-durable execution, recovery, and delivery](docs/pi-durable.md)
- [OptChat memory behavior](docs/optchat-memory.md)
- [Document storage and sharing](docs/documents.md)

## Technologies

TypeScript, Effect v4, Bun, SQLite, Pi-durable, Vercel Chat SDK, Discord, Slack, and Git.
