import { BunSocket } from '@effect/platform-bun'
import { Context, Effect, Exit, Option, Schema, Scope, Stream } from 'effect'
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from 'effect/http'
import { Socket } from 'effect/socket'

const Item = Schema.Record(Schema.String, Schema.Json)
const Body = Schema.fromJsonString(Item)
const decodeBody = Schema.decodeUnknownEffect(Body)
const encodeBody = Schema.encodeSync(Body)
const decodeSignature = Schema.decodeUnknownSync(Body)
const decodeItems = Schema.decodeUnknownOption(Schema.Array(Item))
const decodeCompleted = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal('response.completed'),
    response: Schema.Struct({ id: Schema.String, output: Schema.optionalKey(Schema.Array(Item)) }),
  }),
)
const decodeOutputItem = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literals(['response.output_item.done', 'response.output_item.added']),
    output_index: Schema.optionalKey(Schema.Int),
    item: Item,
  }),
)
const decodeTurnRouting = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literals(['codex.response.metadata', 'response.metadata']),
    headers: Schema.Struct({ 'x-codex-turn-state': Schema.NonEmptyString }),
  }),
)
const isRecord = Schema.is(Item)
const isJsonArray = Schema.is(Schema.Array(Schema.Json))
const isString = Schema.is(Schema.String)
const decodeArguments = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))
const encodeBodyValue = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const orderedJson = (value: Schema.Json): Schema.Json => {
  if (isJsonArray(value)) return value.map(orderedJson)
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, orderedJson(item)]),
    )
  return value
}
const normalizeTerminal = (event: typeof Item.Type): typeof Item.Type => {
  if (event.type !== 'response.done') return event
  const status = isRecord(event.response) ? event.response.status : undefined
  return {
    ...event,
    type:
      status === 'failed'
        ? 'response.failed'
        : status === 'incomplete' || status === 'cancelled'
          ? 'response.incomplete'
          : 'response.completed',
  }
}
const argumentSignature = (value: Schema.Json | undefined) => {
  if (!isString(value)) return value
  const decoded = decodeArguments(value)
  return Option.isSome(decoded) ? encodeBodyValue(orderedJson(decoded.value)) : value
}
const terminal = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error'])
interface ResponseCreateWire extends Record<string, Schema.Json> {
  type: 'response.create'
}

/** Disable continuation for provider diagnostics without changing connection reuse. */
export const ResponsesSocketContinuation = Context.Reference<boolean>(
  '@wednesday/ResponsesSocketContinuation',
  { defaultValue: () => true },
)

/** Optional telemetry receives provider frames without changing the request or retrying it. */
export const ResponsesSocketObserver = Context.Reference<
  (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<(event: typeof Item.Type) => Effect.Effect<void>>
>('@wednesday/ResponsesSocketObserver', {
  defaultValue: () => (_request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed((_event: typeof Item.Type) => Effect.void),
})

const signature = (item: typeof Item.Type) => {
  if (item.type === 'reasoning') return null
  if (item.type === 'function_call')
    return {
      type: item.type,
      call_id: item.call_id,
      name: item.name,
      namespace: item.namespace,
      arguments: argumentSignature(item.arguments),
    }
  const content = isJsonArray(item.content)
    ? item.content.map((part) => {
        if (!isRecord(part) || part.type !== 'output_text') return part
        // The SDK adds empty logprobs/annotations when rebuilding assistant text.
        const text: Record<string, Schema.Json> = Object.fromEntries(
          Object.entries(part).filter(([name]) => name !== 'logprobs'),
        )
        return { ...text, annotations: text.annotations ?? [] }
      })
    : item.content
  return { role: item.role, content, phase: item.phase }
}
export interface ResponseCheckpoint {
  readonly id: string
  readonly input: readonly (typeof Item.Type)[]
  readonly output: readonly (typeof Item.Type)[]
  readonly settings: string
}
const settings = (body: typeof Item.Type) => {
  const { input: _input, previous_response_id: _previous, ...rest } = body
  return JSON.stringify(rest)
}

/** Continue only when the full request replays the same input and completed output. */
export const continueResponse = (
  body: typeof Item.Type,
  previous?: ResponseCheckpoint,
  onMismatch?: (reason: Schema.Json) => void,
) => {
  const mismatch = (reason: Schema.Json) => {
    onMismatch?.(reason)
    return body
  }
  if (!previous) return body
  const decoded = decodeItems(body.input)
  if (Option.isNone(decoded)) return mismatch('invalid-input')
  if (previous.settings !== settings(body)) return mismatch('settings')
  const input = decoded.value
  if (!previous.input.every((item, index) => JSON.stringify(item) === JSON.stringify(input[index])))
    return mismatch('input-prefix')
  const expected = previous.output.map(signature).filter((value) => value !== null)
  const replayed: ReturnType<typeof signature>[] = []
  let offset = previous.input.length
  while (offset < input.length) {
    const item = input[offset]
    if (
      !item ||
      !(item.type === 'reasoning' || item.type === 'function_call' || item.role === 'assistant')
    )
      break
    const value = signature(item)
    if (value !== null) replayed.push(value)
    offset++
  }
  if (JSON.stringify(expected) !== JSON.stringify(replayed))
    return mismatch({
      kind: 'output',
      expectedCount: expected.length,
      replayedCount: replayed.length,
      fields: expected.map((item, index) => {
        const original = decodeSignature(JSON.stringify(item))
        const replay = decodeSignature(JSON.stringify(replayed[index] ?? {}))
        return Object.keys(original).filter(
          (key) => JSON.stringify(original[key]) !== JSON.stringify(replay[key]),
        )
      }),
    })
  return { ...body, input: input.slice(offset), previous_response_id: previous.id }
}

// Acquire an open socket before Effect installs its reader, avoiding a fast-open race.
const openSocket = Effect.fn('ResponsesSocket.open')(function* (
  url: string,
  headers: Readonly<Record<string, string>>,
) {
  const handshakeHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        ![
          'content-length',
          'content-type',
          'transfer-encoding',
          'connection',
          'upgrade',
          'host',
        ].includes(name.toLowerCase()),
    ),
  )
  if (!Object.keys(handshakeHeaders).some((name) => name.toLowerCase() === 'openai-beta'))
    handshakeHeaders['OpenAI-Beta'] = 'responses_websockets=2026-02-06'
  const construct = yield* Socket.WebSocketConstructor
  const ws = yield* Effect.acquireRelease(
    Effect.sync(() => construct(url, { headers: handshakeHeaders })),
    (socket) => Effect.sync(() => socket.close(1000)),
  )
  yield* Effect.callback<void, Socket.SocketError>((resume) => {
    const onOpen = () => resume(Effect.void)
    const onError = (cause: unknown) =>
      resume(
        Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
          }),
        ),
      )
    ws.addEventListener('open', onOpen, { once: true })
    ws.addEventListener('error', onError, { once: true })
    ws.addEventListener('close', onError, { once: true })
    if (ws.readyState === 1) onOpen()
    else if (ws.readyState >= 2) onError('Socket closed during handshake.')
    return Effect.sync(() => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('close', onError)
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: '10 seconds',
      orElse: () =>
        Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({
              kind: 'Timeout',
              cause: 'Provider handshake timed out.',
            }),
          }),
        ),
    }),
  )
  return ws
})

/** A Fold model scope owns one provider connection; the browser still uses HTTP and SSE. */
export const responsesSocketClient = Effect.fn('ResponsesSocket.client')(function* (
  http: HttpClient.HttpClient,
) {
  const owner = yield* Scope.Scope
  const observe = yield* ResponsesSocketObserver
  const continuation = yield* ResponsesSocketContinuation
  let connection:
    | { reader: Socket.Reader; writer: Socket.Writer; scope: Scope.Closeable }
    | undefined
  let previous: ResponseCheckpoint | undefined
  let turnRouting: string | undefined
  let disabled = false
  return HttpClient.make((request, url) =>
    Effect.gen(function* () {
      if (
        disabled ||
        request.method !== 'POST' ||
        !url.pathname.endsWith('/responses') ||
        request.body._tag !== 'Uint8Array'
      )
        return yield* http.execute(request)
      const transportError = (cause: unknown) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause,
            description: 'Provider connection failed.',
          }),
        })
      const body = yield* decodeBody(new TextDecoder().decode(request.body.body)).pipe(
        Effect.mapError(transportError),
      )
      if (body.stream !== true) return yield* http.execute(request)
      if (!connection) {
        const scope = yield* Scope.fork(owner)
        const target = new URL(url)
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
        const opened = yield* Effect.gen(function* () {
          const socket = yield* Socket.fromWebSocket(openSocket(target.href, request.headers))
          const reader = yield* socket.reader
          const writer = yield* socket.writer
          return { reader, writer, scope }
        }).pipe(
          Scope.provide(scope),
          Effect.provide(BunSocket.layerWebSocketConstructor),
          Effect.result,
        )
        if (opened._tag === 'Failure') {
          yield* Scope.close(scope, Exit.void)
          disabled = true
          return yield* http.execute(request)
        }
        connection = opened.success
      }
      const current = connection
      let replayMismatch: Schema.Json = null
      const continued = continuation
        ? continueResponse(body, previous, (reason) => {
            replayMismatch = reason
          })
        : body
      const { stream: _stream, background: _background, ...payload } = continued
      const onEvent = yield* observe(request)
      yield* onEvent({
        type: 'friday.transport',
        incremental: isString(payload.previous_response_id),
        stickyRouting: turnRouting !== undefined,
        replayMismatch,
      })
      const outgoing: ResponseCreateWire = { ...payload, type: 'response.create' }
      if (turnRouting) {
        const metadata: Record<string, Schema.Json> = {}
        if (isRecord(payload.client_metadata))
          for (const [key, value] of Object.entries(payload.client_metadata)) metadata[key] = value
        metadata['x-codex-turn-state'] = turnRouting
        outgoing.client_metadata = metadata
      }
      yield* current.writer.write(encodeBody(outgoing)).pipe(Effect.mapError(transportError))
      let completed = false
      const streamedOutput = new Map<number, typeof Item.Type>()
      const outputIndices = new Map<string, number>()
      let nextOutputIndex = 0
      const encoder = new TextEncoder()
      const events = Stream.fromPull(Effect.succeed(current.reader.pull)).pipe(
        Stream.mapEffect((frame) =>
          decodeBody(isString(frame) ? frame : new TextDecoder().decode(frame)),
        ),
        Stream.map(normalizeTerminal),
        Stream.tap((event) =>
          Effect.gen(function* () {
            yield* onEvent(event)
            // Codex's first token pins follow-ups to the turn's cache backend.
            const routing = decodeTurnRouting(event)
            if (turnRouting === undefined && Option.isSome(routing))
              turnRouting = routing.value.headers['x-codex-turn-state']
            const item = decodeOutputItem(event)
            if (Option.isSome(item)) {
              const id = item.value.item.id
              const index =
                item.value.output_index ??
                (isString(id) ? outputIndices.get(id) : undefined) ??
                nextOutputIndex
              nextOutputIndex = Math.max(nextOutputIndex, index + 1)
              if (isString(id)) outputIndices.set(id, index)
              if (item.value.type === 'response.output_item.done')
                streamedOutput.set(index, item.value.item)
            }
            const done = decodeCompleted(event)
            const input = decodeItems(body.input)
            if (Option.isSome(done) && Option.isSome(input))
              previous = {
                id: done.value.response.id,
                input: input.value,
                // Some Codex completions omit output; item.done frames retain its full replay.
                output:
                  (done.value.response.output?.length ?? 0) === 0 && streamedOutput.size > 0
                    ? [...streamedOutput.entries()]
                        .toSorted(([left], [right]) => left - right)
                        .map(([, value]) => value)
                    : (done.value.response.output ?? []),
                settings: settings(body),
              }
            if (Option.isSome(done)) completed = true
          }),
        ),
        Stream.takeUntil((event) => isString(event.type) && terminal.has(event.type)),
        Stream.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
        Stream.ensuring(
          Effect.suspend(() => {
            if (completed) return Effect.void
            connection = undefined
            previous = undefined
            return Scope.close(current.scope, Exit.void)
          }),
        ),
      )
      return HttpClientResponse.fromWeb(
        request,
        new Response(yield* Stream.toReadableStreamEffect(events), {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
    }),
  )
})
