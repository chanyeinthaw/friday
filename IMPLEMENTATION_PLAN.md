# Agent task implementation plan

Implement one phase at a time. After each phase, stop and report its completed behavior, verification, and any decisions needed before the next phase.

## Phase 1: task contracts and persistence

Define the task-facing vocabulary while persisting each task as an agent thread.

- Add task identifiers, operations, filters, summaries, and typed errors.
- Add the `Tasks` Effect service interface without a live executor.
- Add configured subagent model resolution by exact configured provider and model ID.
- Add persistence queries for agent threads belonging to a channel thread.
- Keep task listing scoped by parent channel thread.
- Verify contracts, model resolution, persistence ordering, and parent scoping.

Completion criterion: callers can describe task operations through typed contracts, resolve only configured subagent models, and list the persisted agent threads belonging to one channel thread.

## Phase 2: background task execution

Implement `Tasks.start` as a non-blocking vertical slice.

- Validate the model, thinking level, and working directory.
- Reject the parent channel workspace for normal tasks.
- Create a subagent `AgentThread` and its first agent-sourced turn.
- Open the agent thread runtime and start the turn in the background.
- Return the task ID immediately.

Completion criterion: a normal task starts in a valid external working directory, persists its thread and initial turn, runs independently, and does not block the channel turn.

## Phase 3: task completion delivery

Deliver agent-thread outcomes back to the parent channel thread.

- Extract reusable channel-turn acceptance and publication from platform ingestion.
- Steer an active channel turn or start a new channel turn.
- Deliver completed, failed, and interrupted task outcomes as agent-sourced input.
- Publish the channel agent's resulting response through its conversation binding.

Completion criterion: a background task outcome automatically reactivates the channel agent and produces the appropriate channel response.

## Phase 4: Pi task tool

Expose task orchestration to channel agents through one Pi tool.

- Register `task` only for channel threads.
- Support `start`, `bootstrap`, `steer`, `list`, and `cancel` inputs.
- Scope every operation to the current channel thread.
- Keep ordinary subagents and bootstrap agents from receiving the tool.
- Return concise task-facing results without thread-runtime internals.

Completion criterion: the channel agent can invoke the typed task interface described by its system prompt, while other agent roles cannot.

## Phase 5: steering, listing, and cancellation behavior

Complete task lifecycle control.

- Steer an active child turn.
- Start a new child turn when the agent thread is idle.
- List active or terminal tasks without polling internals.
- Cancel active work and persist a truthful terminal result.
- Notify the parent when cancellation or failure requires communication.

Completion criterion: channel agents can recover task context, redirect work, continue idle agent threads, and stop active work.

## Phase 6: bootstrap flow

Implement the channel-workspace exception for workspace preparation.

- Start bootstrap agent threads in the channel workspace.
- Apply Friday's bootstrap system prompt.
- Restrict bootstrap work to identifying or preparing another directory.
- Notify the channel agent when preparation completes or needs input.
- Start the user's normal task separately in the prepared directory.

Completion criterion: project work can use a two-stage bootstrap-to-subagent flow without normal subagents inheriting channel-workspace instructions.

## Phase 7: hardening

Strengthen lifecycle and isolation after the full flow works.

- Define writable-directory concurrency rules or isolated worktrees. Implemented: one active task per canonical working directory within a channel; launch validation is serialized in-process.
- Close and retain completed task threads deliberately. Implemented for completed, failed, and interrupted terminal delivery; interrupted cancellation remains active until its terminal event is observed.
- Define restart behavior for active tasks. Current policy remains explicit: active turns are not automatically resumed after process restart; the user or channel agent continues them with a new message.
- Add typed input-required reporting if final-message interpretation is insufficient. Deferred: no concrete reporting case currently requires a separate protocol.
- Mutation-test task state transitions and workspace rules. Implemented with a 100% threshold over the focused task policy module.
- Add an end-to-end acknowledgement, completion, and follow-up publication test. Deferred to the Platform end-to-end suite; focused task completion and channel-turn publication seams are covered independently.

Completion criterion: task behavior remains correct across concurrency, restart, cancellation, and malformed inputs, with focused mutation coverage for critical rules.
