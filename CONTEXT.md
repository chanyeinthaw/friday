# Friday

Friday is a simple personal agent that operates through Discord and delegates work to native agent sessions.

## Language

**Channel workspace**:
The directory associated with a Discord channel. It contains channel-specific agent context, including an `AGENTS.md` file.
_Avoid_: Project workspace

**Thread**:
A durable Friday conversation with an audience, harness session, working directory, model selection, thinking level, and an ordered sequence of turns. A thread may face the user or another agent; an agent-facing thread has a parent thread and parent turn.
_Avoid_: Main thread, subthread

**Channel thread**:
A user-facing thread that represents the continuing conversation for one external channel and has an external binding to that conversation.
_Avoid_: Main thread, user thread

**Agent thread**:
A non-user-facing thread created by another agent to perform delegated work. It reports to its parent thread and parent turn rather than directly to an external channel.
_Avoid_: Subthread, worker thread

**Turn**:
A record of one input message, its source, the final agent message, and the complete ordered activity produced while processing that input. The input source is the user, an agent, or the system.
_Avoid_: Run, execution, delegation

**Activity**:
An ordered record within a turn, such as a steering message, agent commentary, tool call, or tool result. An activity may be active while its content streams and becomes immutable when completed; individual streaming updates are not separate activities. Friday does not record thinking text or thinking-token activities at this stage.
_Avoid_: Event, log entry, streaming chunk

**Steering**:
A user, agent, or system message accepted while a turn is active and passed to the harness as additional input. Steering always remains part of the active turn rather than starting a new turn.
_Avoid_: Follow-up turn, queued turn

**Commentary**:
An intermediate agent message produced during a turn. Commentary is distinct from the final agent message and is not sent to the external channel.
_Avoid_: Final response, delivery

**Channel agent**:
The agent associated with a channel thread. It is the only agent that can spawn agent threads in v1, but it can answer simple requests directly.
_Avoid_: Main agent

**Delegator**:
The role held by the channel agent when it delegates work to subagents. In v1, subagents do not hold this role.
_Avoid_: Subagent

**Subagent**:
The agent operating in an agent thread created by the delegator with a selected model, thinking level, and current working directory.
_Avoid_: Tool call

**Harness**:
The agent execution system used by Friday. Pi is the first harness, while the design permits other harnesses in the future.
_Avoid_: Model provider

**External binding**:
The association between a channel thread and its conversation location on a messaging platform. It identifies the platform, channel, source message, and external thread.
_Avoid_: Discord thread

**Model selection**:
The provider and model identifier used by a thread or turn. A thread stores the current selection; a turn stores the effective selection used for that input.
_Avoid_: Model provider

**Thinking level**:
The reasoning effort requested for a thread or turn. Friday uses Pi's levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` as the canonical values; other harnesses map their values to these levels.
_Avoid_: Thinking token

**Global agent instructions**:
Agent-specific instructions shared across channels and stored in a global `AGENTS.md`.

**Channel context**:
Channel information and recent messages made available through the channel workspace's `AGENTS.md`.

**Input source**:
The origin of a turn's input or steering message: the user, an agent, or the system.
_Avoid_: Message role
