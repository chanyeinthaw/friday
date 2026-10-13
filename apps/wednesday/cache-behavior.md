# Responses request construction and caching

Friday uses Fold's request construction for HTTP Responses calls. It does not capture native provider output and substitute that output into later HTTP requests.

The custom replay adapter preserved the provider's original reasoning, assistant messages, and tool calls. It also required response checkpoints, streamed-event parsing, output comparisons, and cleanup for interrupted requests. We removed that adapter to keep the provider integration smaller.

A CPA comparison with `gpt-6.1-sol` and low thinking effort measured 80.82% in-turn cached input without replay and 88.73% with replay. Each variant completed three turns with seven real OptChat tool calls and two consumed steering messages per turn. These rates are cached input tokens divided by total input tokens across follow-up requests; each turn's first request is excluded. All usage measurements were available.

The replay-disabled variant had two zero-cache follow-ups, and the replay-enabled variant had one. Both preserved their preceding request prefixes and settings. This comparison favors replay in that run, but it does not establish a repeatable benefit or show that Fold's outgoing prefix is unstable. The decision accepts the measured tradeoff for less integration code.

The retained cache behavior is:

- The frozen memory view and initial request share one user message, with stable four-line text blocks. Tool results and steering follow that message.
- Chat uses the user ID for `Session-Id` and the supported OpenAI `prompt_cache_key`. Memory uses a separate identity ending in `:memory`.
- The compatibility client inserts `prompt_cache_key` after SDK conversion, which otherwise drops that field.
- New compaction requests wait while the user's chat turn is active.
- ChatGPT's provider WebSocket continuation remains available. It uses a checked `previous_response_id` to continue on the provider, rather than substituting native output into an HTTP request. An HTTP fallback uses Fold's full request directly.

The [cache benchmark](scripts/cache-benchmark.ts) verifies the tool sequence and consumed steering, checks request prefixes and cache identities, and reports missing usage separately. The current replay-disabled configuration is measured from the repository root with a CPA credential on stdin:

```sh
gopass show --noparsing agents/cpa1-api-key | bun apps/wednesday/scripts/cache-benchmark.ts gpt-6.1-sol responses 3
```

The benchmark creates a disposable database. It does not update saved user settings or conversation history. Its default CPA address is `http://127.0.0.1:8320/v1`; `FRIDAY_CACHE_BENCHMARK_URL` selects another address. The removed replay-enabled adapter is not exposed as a runtime option.
