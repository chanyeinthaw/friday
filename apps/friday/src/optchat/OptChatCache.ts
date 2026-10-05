/* oxlint-disable effecttsgo/async-function, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get -- Pi's onPayload and Proxy forwarding preserve SDK subclass receivers and extra runtime methods. */
import type { Models } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import * as Schema from 'effect/Schema'

const cacheMarks = [50_000, 80_000, 100_000]
const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
type PayloadRecord = typeof recordSchema.Type
const recordsSchema = Schema.Array(recordSchema)
const record = Schema.decodeUnknownSync(recordSchema)
const records = Schema.decodeUnknownSync(recordsSchema)
const isRecords = Schema.is(recordsSchema)
const isRecord = Schema.is(recordSchema)

/** Cut only at line ends; the same view produces identical blocks in every request. */
export const splitOptChatView = (view: string): string[] => {
  const pieces: string[] = []
  let start = 0
  for (const mark of cacheMarks) {
    if (mark >= view.length) continue
    const end = view.lastIndexOf('\n', mark) + 1
    if (end <= start) continue
    pieces.push(view.slice(start, end))
    start = end
  }
  pieces.push(view.slice(start))
  return pieces
}

const withoutCache = (value: PayloadRecord) => {
  const { cache_control: _cache, ...rest } = value
  return rest
}

/** Replace Pi's default marks with three view marks and Anthropic's automatic request-end mark. */
export const cacheOptChatPayload = (input: PayloadRecord, pieces: readonly string[]) => {
  let markedView = false
  const messages = records(input.messages).map((message) => ({
    ...message,
    content: isRecords(message.content)
      ? message.content.map((block, index) => {
          const plain = withoutCache(block)
          const mark =
            !markedView &&
            message.role === 'user' &&
            block.type === 'text' &&
            index < pieces.length - 1 &&
            block.text === pieces[index]
          if (message.role === 'user' && block.text === pieces.at(-1)) markedView = true
          return mark ? { ...plain, cache_control: { type: 'ephemeral' } } : plain
        })
      : message.content,
  }))
  return {
    ...input,
    system: isRecords(input.system) ? input.system.map(withoutCache) : input.system,
    tools: isRecords(input.tools) ? input.tools.map(withoutCache) : input.tools,
    messages,
    cache_control: { type: 'ephemeral' },
  }
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
          index < pieces.length - 1 &&
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
    if (model.api !== 'anthropic-messages' && model.api !== 'openai-responses')
      return models.streamSimple(model, context, cachedOptions)
    return models.streamSimple(model, context, {
      ...cachedOptions,
      onPayload: async (payload, currentModel) => {
        const transformed = await options?.onPayload?.(payload, currentModel)
        const input = record(transformed ?? payload)
        const viewPieces = pieces.slice(0, end + 1)
        return model.api === 'anthropic-messages'
          ? cacheOptChatPayload(input, viewPieces)
          : cacheOptChatResponses(input, viewPieces)
      },
    })
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
