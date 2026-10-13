// Bun-native transport tests require Bun.serve and the Bun test runner.
/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests */
import { expect, test } from 'bun:test'
import { Effect, Fiber, Schema } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import { responsesSocketClient } from './ResponsesSocket.ts'

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)

for (const { cancel, routing, streamed } of [
  { cancel: false, routing: false, streamed: false },
  { cancel: true, routing: false, streamed: false },
  { cancel: false, routing: true, streamed: false },
  { cancel: false, routing: true, streamed: true },
])
  test(`provider socket reuses the connection and closes on ${cancel ? 'cancellation' : 'completion'}${routing ? ' with sticky turn routing' : ''}${streamed ? ' using streamed output items' : ''}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let finishClose = () => {}
        const closed = Effect.callback<void>((resume) => {
          finishClose = () => resume(Effect.void)
        })
        const closing = yield* Effect.forkScoped(closed)
        const requests: Record<string, Schema.Json>[] = []
        let connections = 0
        const provider = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              port: 0,
              fetch(request, server) {
                expect(request.headers.get('content-length')).toBeNull()
                expect(request.headers.get('OpenAI-Beta')).toBe('responses_websockets=2026-02-06')
                if (server.upgrade(request)) return undefined
                return new Response('Upgrade required', { status: 426 })
              },
              websocket: {
                open() {
                  connections++
                },
                message(socket, message) {
                  requests.push(decode(String(message)))
                  if (cancel && requests.length === 2) return
                  if (routing)
                    for (const token of ['first-turn-route', 'later-route'])
                      socket.send(
                        JSON.stringify({
                          type: 'response.metadata',
                          headers: { 'x-codex-turn-state': token },
                        }),
                      )
                  if (streamed)
                    socket.send(
                      JSON.stringify({
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: { role: 'assistant', content: 'Done.' },
                      }),
                    )
                  socket.send(
                    JSON.stringify({
                      type: streamed ? 'response.done' : 'response.completed',
                      response: {
                        id: `response-${requests.length}`,
                        output:
                          requests.at(-1)?.generate === false
                            ? []
                            : [{ role: 'assistant', content: 'Done.' }],
                      },
                    }),
                  )
                },
                close() {
                  finishClose()
                },
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* responsesSocketClient(yield* HttpClient.HttpClient)
            const first = {
              model: 'test',
              prompt_cache_key: 'user-identity',
              stream: true,
              client_metadata: { consumer: 'test' },
              input: [{ role: 'user', content: 'Hello.' }],
            }
            const send = (body: Record<string, Schema.Json>) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.bodyJson(
                  HttpClientRequest.post(`http://127.0.0.1:${provider.port}/v1/responses`),
                  body,
                )
                return yield* client.execute(
                  HttpClientRequest.setHeader(request, 'content-length', '123'),
                )
              })
            yield* (yield* send(first)).text
            const second = yield* send({
              ...first,
              input: [
                ...first.input,
                { role: 'assistant', content: 'Done.' },
                { role: 'user', content: 'Continue.' },
              ],
            })
            if (!cancel) yield* second.text
            expect(connections).toBe(1)
          }),
        )
        yield* Fiber.join(closing)
        expect(requests[0]?.previous_response_id).toBeUndefined()
        expect(requests[0]?.client_metadata).toEqual({ consumer: 'test' })
        expect(requests[1]?.client_metadata).toEqual(
          routing
            ? { consumer: 'test', 'x-codex-turn-state': 'first-turn-route' }
            : { consumer: 'test' },
        )
        if (!cancel)
          expect(requests[1]).toMatchObject({
            previous_response_id: 'response-1',
            input: [{ role: 'user', content: 'Continue.' }],
          })
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    )
  })

test('an unsupported provider falls back to HTTP before sending a model request', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let upgrades = 0
      let posts = 0
      const provider = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              if (request.headers.get('upgrade') === 'websocket') {
                upgrades++
                return new Response('Unsupported', { status: 426 })
              }
              posts++
              return new Response('data: done\n\n')
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const client = yield* responsesSocketClient(yield* HttpClient.HttpClient)
      for (let step = 0; step < 2; step++) {
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(`http://127.0.0.1:${provider.port}/v1/responses`),
          { model: 'test', stream: true, input: [] },
        )
        expect(yield* (yield* client.execute(request)).text).toBe('data: done\n\n')
      }
      expect(upgrades).toBe(1)
      expect(posts).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  )
})
