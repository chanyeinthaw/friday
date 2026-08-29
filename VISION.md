# Friday — Vision 2.0

## Vision

Friday is a simpler personal agent in the same broad category as OpenClaw and Hermes.

It is Discord-first and single-player at first. Its design is harness-neutral for future extensibility, with Pi as the first supported harness.

## Discord interaction

- Each Discord channel has one long-lived channel thread in Friday.
- When the first message arrives for a channel, Friday creates the channel thread and an associated Discord thread rooted at that message.
- The conversation continues in that Discord thread.
- Incoming messages become turns, while messages accepted during an active turn may be recorded as steering activities.
- Only the agent's final output is sent back to Discord.

## Channel workspace

Each Discord channel gets its own workspace directory.

Friday persists the channel name and description on the channel thread and supplies them through the channel agent's system prompt. The channel workspace remains available for channel-specific files and for bootstrap agents that prepare a separate project or task working directory.

## Agent instructions

Pi's normal context discovery remains active. Agent sessions receive layered instructions according to their role and working directory.

A channel agent receives:

1. Friday's channel-agent system prompt, rendered when the harness session opens.
2. The global `AGENTS.md` discovered by Pi.
3. Any applicable `AGENTS.md` files discovered from the channel workspace.

An ordinary subagent receives:

1. Pi's normal system prompt.
2. The global `AGENTS.md` discovered by Pi.
3. The applicable `AGENTS.md` files discovered from the current working directory selected by the channel agent.

A bootstrap agent receives Friday's bootstrap system prompt and may run in the channel workspace only to prepare another working directory.

Friday's role-specific system prompts are separate from `AGENTS.md`. They describe the role of the current agent session, while `AGENTS.md` provides global and working-directory context.

## Agent and subagents

- The channel agent owns the channel thread and is the only agent that can delegate work in v1.
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

Pi is the first harness. Model discovery, provider authentication, and related model capabilities rely on the harness rather than being reimplemented by Friday.

## Initial scope

- Discord first
- Single-player
- Pi first
- Channel workspaces
- Delegator plus first-class native subagents
- Final responses only

Concepts and behavior not stated here remain undecided and will be modeled one layer at a time.
