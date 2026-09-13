import type { ConversationBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'

export type WorkingMessageOperation =
  | 'begin-working'
  | 'update-working'
  | 'finalize-working'
  | 'discard-working'

export interface WorkingMessageInput {
  readonly binding: ConversationBinding
  readonly text: string
}

/**
 * Formats a plain working status for display. Discord renders subtext while
 * Slack keeps the text unchanged. Final responses never pass through here.
 */
export type WorkingStatusFormatter = (status: string) => string

/** Discord has no per-turn status, so working messages render as subtext. */
export const formatDiscordWorkingStatus: WorkingStatusFormatter = (status) => `-# ${status}`

/**
 * Platform-owned transport for the shared working-message lifecycle.
 * The shared helper owns state, orchestration, chunk ordering, and overtaken
 * behavior; adapters own only message identity and transport calls.
 */
export interface WorkingMessageTransport<Handle, E> {
  readonly chunksFor: (text: string) => ReadonlyArray<string>
  readonly post: (binding: ConversationBinding, text: string) => Promise<Handle>
  readonly edit: (handle: Handle, binding: ConversationBinding, text: string) => Promise<Handle>
  readonly delete: (handle: Handle, binding: ConversationBinding) => Promise<void>
  readonly latestId: (binding: ConversationBinding) => Promise<string | undefined>
  readonly idOf: (handle: Handle) => string
  readonly mapError: (operation: WorkingMessageOperation, cause: unknown) => E
  readonly formatWorking?: WorkingStatusFormatter | undefined
}

export interface WorkingMessageLifecycle<E> {
  readonly begin: (message: WorkingMessageInput) => Effect.Effect<void, E>
  readonly update: (message: WorkingMessageInput) => Effect.Effect<void, E>
  readonly finalize: (message: WorkingMessageInput) => Effect.Effect<void, E>
  readonly discard: (binding: ConversationBinding) => Effect.Effect<void, E>
}

interface MarkdownFence {
  readonly marker: string
  readonly openingLine: string
}

const splitBoundary = (text: string, maxLength: number): number => {
  const window = text.slice(0, maxLength)
  const minimumSoftBreak = Math.floor(maxLength / 2)
  const paragraph = window.lastIndexOf('\n\n')
  const line = window.lastIndexOf('\n')
  const word = window.lastIndexOf(' ')
  let boundary =
    paragraph >= minimumSoftBreak
      ? paragraph + 2
      : line >= minimumSoftBreak
        ? line + 1
        : word >= minimumSoftBreak
          ? word + 1
          : maxLength
  const previous = text.charCodeAt(boundary - 1)
  const next = text.charCodeAt(boundary)
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) boundary -= 1
  return boundary
}

const fenceAfter = (
  text: string,
  initial: MarkdownFence | undefined,
): MarkdownFence | undefined => {
  let fence = initial
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue
    const marker = match[1] ?? ''
    const trailing = match[2] ?? ''
    if (!fence) {
      fence = { marker, openingLine: line }
    } else if (
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      trailing.trim().length === 0
    ) {
      fence = undefined
    }
  }
  return fence
}

const closingFence = (fence: MarkdownFence): string => fence.marker

/**
 * Splits at readable boundaries and keeps fenced Markdown code valid in every chunk.
 * Continued code blocks are closed and reopened with their original language tag.
 */
export const splitMessage = (text: string, maxLength: number): ReadonlyArray<string> => {
  if (text.length <= maxLength) return [text]
  const chunks: Array<string> = []
  let remaining = text
  let activeFence: MarkdownFence | undefined

  while (remaining.length > 0) {
    const prefix = activeFence ? `${activeFence.openingLine}\n` : ''
    let rawLength = Math.min(remaining.length, maxLength - prefix.length)
    if (rawLength <= 0) {
      // A pathological fence declaration can consume the whole message limit.
      // Fall back to raw splitting rather than producing an oversized message.
      const boundary = splitBoundary(remaining, maxLength)
      chunks.push(remaining.slice(0, boundary))
      remaining = remaining.slice(boundary)
      activeFence = undefined
      continue
    }

    let boundary = rawLength === remaining.length ? rawLength : splitBoundary(remaining, rawLength)
    let raw = remaining.slice(0, boundary)
    let nextFence = fenceAfter(raw, activeFence)
    let suffix = nextFence ? `${raw.endsWith('\n') ? '' : '\n'}${closingFence(nextFence)}` : ''

    while (prefix.length + raw.length + suffix.length > maxLength && boundary > 1) {
      rawLength = Math.max(1, rawLength - (prefix.length + raw.length + suffix.length - maxLength))
      boundary = splitBoundary(remaining, rawLength)
      raw = remaining.slice(0, boundary)
      nextFence = fenceAfter(raw, activeFence)
      suffix = nextFence ? `${raw.endsWith('\n') ? '' : '\n'}${closingFence(nextFence)}` : ''
    }

    chunks.push(`${prefix}${raw}${suffix}`)
    remaining = remaining.slice(boundary)
    activeFence = nextFence
  }

  return chunks
}

/**
 * Shared working-message lifecycle: posts `Thinking...`, edits the same message
 * for activity changes, and finalizes with overtaken awareness. On non-empty
 * finalization the tracked message is edited into the first chunk when still
 * latest, otherwise deleted and reposted fresh at the bottom. Empty
 * finalization and discard delete the tracked message best-effort. Transport
 * failures propagate so callers keep their publish fallback; overtaken and
 * discard deletes stay best-effort because a message deleted upstream is not a
 * failure.
 */
const keyFor = (binding: ConversationBinding): string => String(binding.conversationId)

export const makeWorkingMessageLifecycle = <Handle, E>(
  transport: WorkingMessageTransport<Handle, E>,
): WorkingMessageLifecycle<E> => {
  const tracked = new Map<string, Handle>()

  const begin = Effect.fn('WorkingMessageLifecycle.begin')(function* (
    message: WorkingMessageInput,
  ) {
    const display =
      transport.formatWorking !== undefined ? transport.formatWorking(message.text) : message.text
    const handle = yield* Effect.tryPromise({
      try: () => transport.post(message.binding, display),
      catch: (cause) => transport.mapError('begin-working', cause),
    })
    tracked.set(keyFor(message.binding), handle)
  })

  const update = Effect.fn('WorkingMessageLifecycle.update')(function* (
    message: WorkingMessageInput,
  ) {
    const key = keyFor(message.binding)
    const existing = tracked.get(key)
    if (existing === undefined) return
    const display =
      transport.formatWorking !== undefined ? transport.formatWorking(message.text) : message.text
    const next = yield* Effect.tryPromise({
      try: () => transport.edit(existing, message.binding, display),
      catch: (cause) => transport.mapError('update-working', cause),
    })
    tracked.set(key, next)
  })

  const postAll = Effect.fn('WorkingMessageLifecycle.postAll')(function* (
    binding: ConversationBinding,
    text: string,
  ) {
    for (const chunk of transport.chunksFor(text)) {
      yield* Effect.tryPromise({
        try: () => transport.post(binding, chunk),
        catch: (cause) => transport.mapError('finalize-working', cause),
      }).pipe(Effect.asVoid)
    }
  })

  const finalize = Effect.fn('WorkingMessageLifecycle.finalize')(function* (
    message: WorkingMessageInput,
  ) {
    const key = keyFor(message.binding)
    const existing = tracked.get(key)
    tracked.delete(key)
    if (message.text.trim().length === 0) {
      if (existing !== undefined) {
        yield* Effect.tryPromise({
          try: () => transport.delete(existing, message.binding),
          catch: (cause) => transport.mapError('finalize-working', cause),
        }).pipe(Effect.ignore)
      }
      return
    }
    const chunks = transport.chunksFor(message.text)
    const first = chunks[0] ?? ''
    if (existing === undefined) {
      yield* postAll(message.binding, message.text)
      return
    }
    const latest = yield* Effect.tryPromise({
      try: () => transport.latestId(message.binding),
      catch: (cause) => transport.mapError('finalize-working', cause),
    })
    if (latest === transport.idOf(existing)) {
      yield* Effect.tryPromise({
        try: () => transport.edit(existing, message.binding, first),
        catch: (cause) => transport.mapError('finalize-working', cause),
      }).pipe(Effect.asVoid)
      for (const chunk of chunks.slice(1)) {
        yield* Effect.tryPromise({
          try: () => transport.post(message.binding, chunk),
          catch: (cause) => transport.mapError('finalize-working', cause),
        }).pipe(Effect.asVoid)
      }
    } else {
      yield* Effect.tryPromise({
        try: () => transport.delete(existing, message.binding),
        catch: (cause) => transport.mapError('finalize-working', cause),
      }).pipe(Effect.ignore)
      yield* postAll(message.binding, message.text)
    }
  })

  const discard = Effect.fn('WorkingMessageLifecycle.discard')(function* (
    binding: ConversationBinding,
  ) {
    const key = keyFor(binding)
    const existing = tracked.get(key)
    tracked.delete(key)
    if (existing !== undefined) {
      yield* Effect.tryPromise({
        try: () => transport.delete(existing, binding),
        catch: (cause) => transport.mapError('discard-working', cause),
      }).pipe(Effect.ignore)
    }
  })

  return { begin, update, finalize, discard }
}
