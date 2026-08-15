# Orbs at Home

Orbs at Home is a simple personal agent that operates through Discord and delegates work to native agent sessions.

## Language

**Channel workspace**:
The directory associated with a Discord channel. It contains channel-specific agent context, including an `AGENTS.md` file.
_Avoid_: Project workspace

**Agent thread**:
The agent conversation started when a message arrives in a Discord channel. Subsequent conversation continues in that thread.
_Avoid_: Discord thread

**Channel agent**:
The agent associated with a channel conversation. It is the only agent that can spawn subagents in v1, but it can answer simple requests directly.
_Avoid_: Subagent

**Delegator**:
The role held by the channel agent when it delegates work to subagents. In v1, subagents do not hold this role.
_Avoid_: Subagent

**Subagent**:
A native agent session spawned by the delegator with a selected model, thinking level, and current working directory.
_Avoid_: Tool call

**Harness**:
The agent execution system used by Orbs at Home. Pi is the first harness, while the design permits other harnesses in the future.
_Avoid_: Model provider

**Global agent instructions**:
Agent-specific instructions shared across channels and stored in a global `AGENTS.md`.

**Channel context**:
Channel information and recent messages made available through the channel workspace's `AGENTS.md`.
