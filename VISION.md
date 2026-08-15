# Orbs at Home — Vision 2.0

## Vision

Orbs at Home is a simpler personal agent in the same broad category as OpenClaw and Hermes.

It is Discord-first and single-player at first. Its design is harness-neutral for future extensibility, with Pi as the first supported harness.

## Discord interaction

- When a message arrives in a Discord channel, the agent starts a new agent thread.
- The conversation continues in that thread.
- Only the agent's final output is sent back to Discord.

## Channel workspace

Each Discord channel gets its own workspace directory.

The workspace contains an `AGENTS.md` file with:

- Channel information, including its name and description.
- The most recent N messages from before the current message.

The workspace allows the conversation to continue with channel-specific context.

## Agent instructions

Pi's normal context discovery remains active. Agent sessions receive layered instructions according to their role and working directory.

A channel agent receives:

1. Special channel-agent instructions supplied by Orbs at Home.
2. The global `AGENTS.md` discovered by Pi.
3. The channel workspace's `AGENTS.md`, discovered from the channel agent's current working directory.

A subagent receives:

1. Special subagent instructions supplied by Orbs at Home.
2. The global `AGENTS.md` discovered by Pi.
3. The applicable `AGENTS.md` files discovered from the current working directory selected by the channel agent.

The role-specific instructions are separate from `AGENTS.md`. They describe the role of the current agent session, while `AGENTS.md` provides global and working-directory context.

## Agent and subagents

- The channel agent is the only agent that can delegate work in v1.
- The channel agent can answer simple requests directly instead of always spawning a subagent.
- Subagents are a first-class capability.
- A subagent is a native agent session.
- The delegator can spawn a subagent while specifying:
  - Model
  - Thinking level
  - Current working directory
- In v1, only the delegator can spawn subagents.

## Harness boundary

The design should remain harness-neutral so other harnesses can be supported later.

Pi is the first harness. Model discovery, provider authentication, and related model capabilities rely on the harness rather than being reimplemented by Orbs at Home.

## Initial scope

- Discord first
- Single-player
- Pi first
- Channel workspaces
- Delegator plus first-class native subagents
- Final responses only

Concepts and behavior not stated here remain undecided and will be modeled one layer at a time.
