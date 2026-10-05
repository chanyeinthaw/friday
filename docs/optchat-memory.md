# OptChat memory behavior

Friday implements the binary summary tree and incremental view described in the [OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).

## Context and execution

Each new OptChat run receives a frozen view of earlier history followed by the complete current input. Earlier assistant and tool messages are excluded from model context. Tools, reasoning, and steering from the current run remain in Pi's request tail.

The view is persisted against the run's first input submission ID, which stays stable across generation tasks. Retries and recovery reuse it. A follow-up starts a fresh run and view. A steering message joins the active run without resetting it. Friday keeps Pi's resource loader and system-prompt builder, then adds memory instructions and the scoped `zoom` and `date` tools.

Request hooks change context without replacing Pi-durable's execution, transcript, scheduling, or recovery. A small patch makes `beforeRequest` hook errors fail the task rather than silently send untransformed history. OptChat declines Pi's ordinary compaction. A current run can still exceed its model's context window.

## Storage and summaries

The full Pi transcript remains in `pi-durable.sqlite`. OptChat's indexed message projection, immutable summary nodes, incremental view, and worker progress live in `friday.sqlite`.

Memory IDs separate all queries and writes. Source keys deduplicate transcript projection after a restart. Binding identities cannot transfer an existing memory to another owner or channel. Enrollment intervals exclude earlier normal-channel history and messages sent while the binding is disabled.

Messages retain user text, assistant text, tool calls, and tool results. Reasoning is excluded from memory projection. Tool-result text retains its head and tail when capped at 30,000 characters. Pi retains the original transcript. Background task reports enter the originating memory as `work`; task internals stay in their own transcripts.

Each leaf summarizes one message. Each parent combines exactly two children. Sources that fit 512 UTF-8 bytes become nodes without a model call. Other sources use the reference compression prompt, with Friday's name, and up to five corrective attempts in the same utility conversation. The shortest attempt wins, even when slightly oversized.

The view targets 128,000 UTF-8 bytes of summary text. It appends new leaves and merges the oldest due adjacent siblings with built parents. It never splits a merged part or drops history to meet the budget. Missing summaries block the next run; interruption cancels that wait.

Up to eight ready nodes run concurrently per memory. Leaves build in order, while eligible merges run alongside. Successful nodes persist independently of failed jobs. The scoped worker resumes missing nodes from SQLite after restart and retries on a ten-second cadence. A foreground wait also drains missing work. Completed worker passes avoid rescanning idle history.

`zoom(id, n)` returns two children for an aligned power-of-two range. `zoom(id, 1)` returns indexed message text. `date(id)` returns its recorded ISO timestamp.

## Differences from the reference

Friday uses SQLite transactions instead of daily JSONL files and Git commits. Pi's durable input is recorded before model preparation; the memory view excludes that input and is frozen before it enters the indexed memory projection.

Existing history is not imported automatically. The implementation has no history-import or HTML memory-browser command. Images remain in Pi's transcript and input envelopes; the summary tree summarizes text rather than image contents.

Provider caching uses Pi's existing transport behavior. The reference's explicit view breakpoints and claimed token-cost savings are not implemented or verified. The byte budget is fixed; its token size depends on the model and language.
