import { test, expect } from 'bun:test'
import { Effect, Layer, Schema } from 'effect'
import { Prompt } from 'effect/ai'
import { SqliteClient } from '@effect/sql-sqlite-bun'
import { AgentId, MessageId, ToolCallId, LogEntryInput } from '@humanlayer/fold-core'
import { Storage } from './Storage.ts'
import { sqliteMigrations, sqliteStorage } from './SqliteStorage.ts'

const decodeEntry = Schema.decodeUnknownEffect(LogEntryInput)
const encodeUser = Schema.encodeSync(Prompt.UserMessage)
const encodeAssistant = Schema.encodeSync(Prompt.AssistantMessage)
const encodeTool = Schema.encodeSync(Prompt.ToolMessage)

test('tool activity survives history and reconnect, records failures, and settles interrupted calls', async () => {
  const database = SqliteClient.layer({ filename: ':memory:' })
  const storage = sqliteStorage.pipe(
    Layer.provide(sqliteMigrations.pipe(Layer.provide(database))),
    Layer.provide(database),
  )
  // Bun SQLite requires the Bun integration runner.
  // oxlint-disable-next-line effect-local/no-manual-effect-runtime-in-tests
  await Effect.runPromise(
    Effect.gen(function* () {
      const stored = yield* Storage
      const agentId = AgentId.create()
      const envelope = () => ({
        agentId,
        parentAgentId: null,
        toolCallId: null,
        messageId: MessageId.create(),
      })
      yield* stored.appendLog(
        'alice',
        yield* decodeEntry({
          ...envelope(),
          _tag: 'user-message',
          message: encodeUser(
            Prompt.userMessage({ content: [Prompt.textPart({ text: 'Search for Effect' })] }),
          ),
        }),
        null,
      )
      const call = ToolCallId.create()
      const started = yield* stored.appendLog(
        'alice',
        yield* decodeEntry({
          ...envelope(),
          _tag: 'assistant-message',
          message: encodeAssistant(
            Prompt.assistantMessage({
              content: [
                Prompt.toolCallPart({
                  id: call,
                  name: 'web_search',
                  params: { query: 'Effect documentation' },
                  providerExecuted: false,
                }),
              ],
            }),
          ),
          finish: null,
        }),
        null,
      )
      expect(started.messages[0]?.activity).toMatchObject({
        id: call,
        input: 'Effect documentation',
        status: 'running',
      })
      const result = yield* stored.appendLog(
        'alice',
        yield* decodeEntry({
          ...envelope(),
          toolCallId: call,
          _tag: 'tool-result',
          message: encodeTool(
            Prompt.toolMessage({
              content: [
                Prompt.toolResultPart({
                  id: call,
                  name: 'web_search',
                  result: 'Rate limit reached',
                  isFailure: true,
                  providerExecuted: false,
                }),
              ],
            }),
          ),
        }),
        null,
      )
      expect(result.messages.find((message) => message.activity)?.activity).toMatchObject({
        status: 'failed',
        output: 'Rate limit reached',
      })
      const history = yield* stored.history('alice')
      expect(history.messages.find((message) => message.activity)?.activity?.status).toBe('failed')
      expect(
        (yield* stored.messages('alice', started.messages[0]?.id)).find(
          (message) => message.activity,
        )?.activity?.status,
      ).toBe('failed')
      expect((yield* stored.history('bob')).messages).toEqual([])
      const unfinished = ToolCallId.create()
      yield* stored.appendLog(
        'alice',
        yield* decodeEntry({
          ...envelope(),
          _tag: 'assistant-message',
          message: encodeAssistant(
            Prompt.assistantMessage({
              content: [
                Prompt.toolCallPart({
                  id: unfinished,
                  name: 'bash',
                  params: { command: 'cat /attachments/notes.md' },
                  providerExecuted: false,
                }),
              ],
            }),
          ),
          finish: null,
        }),
        null,
      )
      expect((yield* stored.settleActivities('alice'))[0]?.activity?.status).toBe('stopped')
      expect((yield* stored.settleActivities('alice')).length).toBe(0)
      yield* stored.appendLog(
        'alice',
        yield* decodeEntry({
          ...envelope(),
          _tag: 'assistant-message',
          message: encodeAssistant(
            Prompt.assistantMessage({
              content: [
                Prompt.toolCallPart({
                  id: ToolCallId.create(),
                  name: 'date',
                  params: { id: 0 },
                  providerExecuted: false,
                }),
              ],
            }),
          ),
          finish: null,
        }),
        null,
      )
      yield* stored.recover()
      const recovered = yield* stored.history('alice')
      expect(recovered.messages.some((message) => message.activity?.status === 'running')).toBe(
        false,
      )
      expect(recovered.messages.at(-1)?.activity).toMatchObject({
        input: 'Message 1',
        status: 'stopped',
      })
    }).pipe(Effect.provide(storage), Effect.scoped),
  )
})
