/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function -- Bun and the local provider stream are SDK adapter boundaries. */
import { expect, test } from 'bun:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import { splitOptChatView, withOptChatCache } from './OptChatCache.ts'

const fixture = Effect.gen(function* () {
  const sent = yield* Queue.make<number>()
  const gates: Array<{ response: Deferred.Deferred<void>; body: Deferred.Deferred<void> }> = []
  const faux = fauxProvider({ api: 'openai-completions', provider: 'cache-test' })
  const models = createModels()
  let completed = 0
  models.setProvider({
    ...faux.provider,
    streamSimple: (model, context, options) => {
      const index = gates.length
      const gate = { response: Deferred.makeUnsafe<void>(), body: Deferred.makeUnsafe<void>() }
      gates.push(gate)
      const stream = createAssistantMessageEventStream()
      const answer = fauxAssistantMessage('summary')
      void Effect.runPromise(
        Effect.gen(function* () {
          const user = context.messages.find((message) => message.role === 'user')
          const payload = {
            model: model.id,
            tools: [],
            messages: [
              {
                role: 'system',
                content: context.messages.find((message) => message.role === 'system')?.content,
              },
              { role: 'user', content: user?.content },
            ],
          }
          const transformed = yield* Effect.promise(async () =>
            options?.onPayload?.(payload, model),
          )
          expect(transformed ?? payload).toEqual(payload)
          yield* Queue.offer(sent, index)
          yield* Deferred.await(gate.response)
          yield* Effect.promise(async () =>
            options?.onResponse?.({ status: 200, headers: {} }, model),
          )
          stream.push({ type: 'start', partial: answer })
          yield* Deferred.await(gate.body)
          completed++
        }),
        { signal: options?.signal },
      ).then(
        () => stream.push({ type: 'done', reason: 'stop', message: answer }),
        () =>
          stream.push({
            type: 'error',
            reason: 'aborted',
            error: fauxAssistantMessage('', { stopReason: 'aborted' }),
          }),
      )
      return stream
    },
  })
  const request = (system = 'constant', apiKey = 'test-account') => ({
    model: faux.getModel(),
    context: {
      systemPrompt: system,
      messages: [
        {
          role: 'user' as const,
          timestamp: 0,
          content: [
            ...splitOptChatView('<chat>\n0+1|one\n1+1|two\n2+1|three\n3+1|four\n</chat>').map(
              (text) => ({ type: 'text' as const, text }),
            ),
            { type: 'text' as const, text: 'Compaction: compress this message.' },
          ],
        },
      ],
    },
    options: { apiKey },
  })
  const start = (system = 'constant', apiKey = 'test-account', signal?: AbortSignal) => {
    const input = request(system, apiKey)
    const cached = withOptChatCache(models)
    if (signal === undefined) return cached.streamSimple(input.model, input.context, input.options)
    return cached.streamSimple(input.model, input.context, { ...input.options, signal })
  }
  return { sent, gates, start, completed: () => completed }
})

test('separate wrappers share cache-write coordination and release at response start', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture
      const first = f.start()
      expect(yield* Queue.take(f.sent)).toBe(0)
      const second = f.start()
      const unrelated = f.start('different prefix')
      expect(yield* Queue.take(f.sent)).toBe(2)
      const firstGate = f.gates[0]
      expect(firstGate).toBeDefined()
      if (firstGate === undefined) return
      yield* Deferred.succeed(firstGate.response, undefined)
      expect(yield* Queue.take(f.sent)).toBe(1)
      expect(f.completed()).toBe(0)
      for (const gate of f.gates) {
        yield* Deferred.succeed(gate.response, undefined)
        yield* Deferred.succeed(gate.body, undefined)
      }
      yield* Effect.promise(() =>
        Promise.all([first.result(), second.result(), unrelated.result()]),
      )
    }).pipe(Effect.scoped, Effect.timeout('5 seconds')),
  ))

test('an aborted writer releases waiters and another account proceeds independently', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture
      const writer = yield* Effect.tryPromise({
        try: (signal) => f.start('constant', 'account-one', signal).result(),
        catch: () => new Error('Provider failed.'),
      }).pipe(Effect.forkChild)
      expect(yield* Queue.take(f.sent)).toBe(0)
      const follower = f.start('constant', 'account-one')
      const otherAccount = f.start('constant', 'account-two')
      expect(yield* Queue.take(f.sent)).toBe(2)
      yield* Fiber.interrupt(writer)
      expect(yield* Queue.take(f.sent)).toBe(1)
      for (const gate of f.gates) {
        yield* Deferred.succeed(gate.response, undefined)
        yield* Deferred.succeed(gate.body, undefined)
      }
      yield* Effect.promise(() => Promise.all([follower.result(), otherAccount.result()]))
    }).pipe(Effect.scoped, Effect.timeout('5 seconds')),
  ))
