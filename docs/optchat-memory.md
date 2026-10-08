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

Each leaf summarizes one message. Each parent combines exactly two children. Sources that fit 512 UTF-8 bytes become nodes without a model call. Other sources use the compression prompt with Friday's name, a ruler of 512 dashes, and up to five corrective attempts in the same utility conversation. The prompt separates source text in `<input>` from context in `<chat>`. The shortest attempt wins, even when slightly oversized.

The view grows by appending leaves until its rendered size exceeds 128,000 UTF-8 bytes. One batch then merges built sibling pairs until the view fits 64,000 bytes. A pair's priority is its age since its last message, divided by the size of one child. Ties select the oldest pair. Measuring age from the first message rewrites old prefixes unnecessarily, the cache bug corrected in Victor's updated recipe.

If parents are missing, the batch remains pending and resumes as nodes become available, even after a restart. The saved view is never rebuilt from history. Missing visible summaries block the next run; interruption cancels that wait.

Compactions use a separate persisted view with 16,000-byte and 32,000-byte limits. It appends built lines and starts a new batch when the main view merges. Each request includes only lines ending before its source boundary and the first unbuilt line. Both views measure rendered UTF-8 bytes, including line addresses and delimiters.

Up to eight ready nodes run concurrently per memory. Leaves build in order, while eligible merges run alongside. Each completed node advances a pending batch and frees a slot for newly ready work. Appending messages does not wait for model calls. Successful nodes persist independently of failed jobs. The scoped worker resumes missing nodes from SQLite after restart and retries on a ten-second cadence. A foreground wait needs only the visible summaries, so unrelated merges do not block a new turn. Completed worker passes avoid rescanning idle history.

`zoom(id, n)` returns two children for an aligned power-of-two range. `zoom(id, 1)` returns indexed message text. `date(id)` returns its recorded ISO timestamp.

## Differences from the reference

Friday uses SQLite transactions instead of daily JSONL files and Git commits. Pi's durable input is recorded before model preparation; the memory view excludes that input and is frozen before it enters the indexed memory projection.

Existing Pi session JSONL history is imported explicitly with `friday config optchat import <memory-id> <path>`. The implementation has no automatic import or HTML memory-browser command. Images remain in Pi's transcript and input envelopes; the summary tree summarizes text rather than image contents.

An import requires an enabled binding and reads the source file without modifying it. It validates every line and the session header, follows only the active leaf branch, and maps the branch with the same projection as live memory: user text with prompt-envelope unwrapping, assistant text and tool calls, capped tool results, reasoning exclusion, image placeholders, and message timestamps. Compaction and branch-summary entries are skipped so summaries never replace original text. Invalid timestamps fail the import instead of substituting a date. Mapping completes before any write, and the append runs in the existing single atomic transaction. Source keys combine the session ID, entry ID, and message indexes, so importing the same file twice or reimporting a grown session adds no duplicates. Reimports reject edits, omissions, or branch changes that conflict with previously imported entries, preserving immutable memory. Missing or forward parent links and duplicate entry IDs are rejected before mapping. No summarization model runs during import.

The view is split into blocks of four summary lines, with the closing `</chat>` in the final block. Complete blocks stay identical as messages are appended. Chat Completions requests preserve their existing payload and use the provider's implicit prefix cache. Compatible OpenAI Responses requests use explicit view marks plus implicit request-end caching, `store: false`, and `reasoning.context: all_turns`. Pi retains encrypted reasoning items. The compactor uses the same view blocks before its separate compression-step block.

OpenAI Responses marks are enabled only when Pi's model compatibility includes `prompt_cache_options`. Chat Completions providers use their existing implicit caching and have no equivalent explicit marks. Friday's current custom provider uses Chat Completions, so these changes do not establish improved live cache hit rates. Token-cost savings still need provider usage measurements. The byte budget is fixed; its token size depends on the model and language.

Turns and compactions share one set of instructions. Each channel request saves its exact system prompt and ordered tool declarations in `optchat_prefixes`. Compactions load that prefix, including after a restart, and keep it unchanged across corrective attempts. Tool declarations appear in compaction requests for cache reuse, but the compactor registers no tool executors. Model calls wait until a channel has recorded its prefix. Short sources still become nodes without a model call.

OptChat Chat Completions and Responses wrappers for one model runtime share coordination for in-flight cache writes. A request waits for earlier requests with the same leading system or developer messages and tool declarations. Waiters resume when the HTTP response starts, without waiting for the generated answer. A terminal error or abort also releases waiters. Keys hash the provider, model, endpoint, supplied authentication options, and actual prefix. Different prefixes and supplied accounts proceed independently. The coordinator records only in-flight writes, leaving expiry and cache reads to the provider.

Cache reuse between turns and compactions requires the same model and account. Friday continues to use its configured utility model for compactions. The worker scans persisted nodes for missing work instead of maintaining ready-node queues.

OptChat uses memory instructions adapted for Friday. Its channel policy lets the agent do work directly and use background tasks only when requested. Normal channels keep Friday's existing task policy.
