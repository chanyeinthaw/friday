/* oxlint-disable effecttsgo/async-function, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get -- Pi's onPayload and Proxy forwarding preserve SDK subclass receivers and extra runtime methods. */
import type { Models } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import * as Schema from 'effect/Schema'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'

const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
type PayloadRecord = typeof recordSchema.Type
const recordsSchema = Schema.Array(recordSchema)
const record = Schema.decodeUnknownSync(recordSchema)
const records = Schema.decodeUnknownSync(recordsSchema)
const isRecords = Schema.is(recordsSchema)
const isRecord = Schema.is(recordSchema)

/** Stable four-line blocks preserve the view prefix as messages are appended. */
export const splitOptChatView = (view: string): string[] => {
  const pieces: string[] = []
  let start = 0
  let lines = 0
  let position = view.indexOf('\n') + 1
  while (position > 0 && position < view.length) {
    const end = view.indexOf('\n', position) + 1
    if (end === 0) break
    if (++lines % 4 === 0) {
      pieces.push(view.slice(start, end))
      start = end
    }
    position = end
  }
  pieces.push(view.slice(start))
  return pieces
}

/** Only in-flight writes are tracked; provider cache lifetimes remain provider-owned. */
const makeOptChatCacheWrites = () => {
  const pending = new Map<string, Deferred.Deferred<void>>()
  return (key: string) => {
    const current = pending.get(key)
    if (current !== undefined) return { wait: Deferred.await(current), release: () => {} }
    const ready = Deferred.makeUnsafe<void>()
    pending.set(key, ready)
    return {
      wait: Effect.void,
      release: () => {
        if (pending.get(key) !== ready) return
        pending.delete(key)
        Deferred.doneUnsafe(ready, Effect.void)
      },
    }
  }
}
const writesByModels = new WeakMap<Models, ReturnType<typeof makeOptChatCacheWrites>>()

const digest = async (value: PayloadRecord) => {
  const hashed = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  )
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Hash account/request identity so credentials never appear in the coordination map. */
const cacheWriteKey = (
  input: PayloadRecord,
  model: Parameters<Models['streamSimple']>[0],
  options: Parameters<Models['streamSimple']>[2],
) => {
  const items = records(model.api === 'openai-responses' ? input.input : input.messages)
  const firstUser = items.findIndex((item) => item.role === 'user')
  return digest({
    provider: model.provider,
    api: model.api,
    model: model.id,
    url: model.baseUrl,
    apiKey: options?.apiKey,
    headers: options?.headers,
    env: options?.env,
    tools: input.tools,
    instructions: input.instructions,
    // The actual leading system/developer items are shared by turns and compactions.
    prefix: firstUser < 0 ? items : items.slice(0, firstUser),
  })
}

/** Responses keeps encrypted reasoning items intact and uses the same explicit view marks at every step. */
export const cacheOptChatResponses = (input: PayloadRecord, pieces: readonly string[]) => {
  const reasoning = isRecord(input.reasoning)
    ? { ...input.reasoning, context: 'all_turns' }
    : input.reasoning
  if (!isRecord(input.prompt_cache_options)) return { ...input, store: false, reasoning }
  let markedView = false
  const items = records(input.input).map((item) => {
    if (!isRecords(item.content)) return item
    return {
      ...item,
      content: item.content.map((block, index) => {
        const mark =
          !markedView &&
          item.role === 'user' &&
          block.type === 'input_text' &&
          index === pieces.length - 2 &&
          block.text === pieces[index]
        if (item.role === 'user' && block.text === pieces.at(-1)) markedView = true
        return mark ? { ...block, prompt_cache_breakpoint: { mode: 'explicit' } } : block
      }),
    }
  })
  return {
    ...input,
    input: items,
    store: false,
    reasoning,
    prompt_cache_options: { ...input.prompt_cache_options, mode: 'implicit', ttl: '30m' },
  }
}

/** Apply provider caching only to explicit OptChat/compactor view blocks; ordinary Pi requests are untouched. */
export const withOptChatCache = (models: Models): Models => {
  const writes = writesByModels.get(models) ?? makeOptChatCacheWrites()
  writesByModels.set(models, writes)
  const streamSimple: Models['streamSimple'] = (model, context, options) => {
    const transcript = normalizeContext(context)
    const first = transcript.messages.find((message) => message.role === 'user')
    const content = first?.content
    const blocks = Array.isArray(content) ? content : []
    const pieces = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    if (!pieces[0]?.startsWith('<chat>\n')) return models.streamSimple(model, context, options)
    const end = pieces.findIndex((piece) => piece.includes('</chat>'))
    if (end < 0) return models.streamSimple(model, context, options)
    const cachedOptions = {
      ...options,
      cacheRetention: 'short' as const,
    }
    if (model.api !== 'openai-completions' && model.api !== 'openai-responses')
      return models.streamSimple(model, context, cachedOptions)
    let release = () => {}
    let finished = false
    const finish = () => {
      finished = true
      release()
    }
    const stream = models.streamSimple(model, context, {
      ...cachedOptions,
      onPayload: async (payload, currentModel) => {
        const transformed = await options?.onPayload?.(payload, currentModel)
        const input = record(transformed ?? payload)
        const viewPieces = pieces.slice(0, end + 1)
        const cached =
          model.api === 'openai-responses' ? cacheOptChatResponses(input, viewPieces) : input
        const key = await cacheWriteKey(cached, currentModel, options)
        // Hashing is asynchronous; the stream may already have ended or been cancelled.
        if (finished || options?.signal?.aborted) return cached
        const lease = writes(key)
        release = lease.release
        await Effect.runPromise(lease.wait, { signal: options?.signal })
        return cached
      },
      onResponse: async (response, currentModel) => {
        finish()
        await options?.onResponse?.(response, currentModel)
      },
    })
    // Error, abort, or an adapter that never calls onResponse must also release waiters.
    void stream.result().then(finish, finish)
    return stream
  }
  // ModelRuntime has private fields and prototype methods, so preserve their original receiver.
  return new Proxy(models, {
    get(target, property) {
      if (property === 'streamSimple') return streamSimple
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
