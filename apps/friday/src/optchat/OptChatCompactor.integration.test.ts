/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function -- Bun and the faux provider are the integration boundary. */
import { test, expect } from 'bun:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { AppConfig } from '../config/AppConfig.ts'
import { makeOptChatCompressor } from './OptChatCompactor.ts'
import { bytes } from './OptChatTree.ts'
import { optChatInstructions } from './OptChatPrompt.ts'

const decodeUtility = Schema.decodeUnknownSync(AppConfig.fields.models.fields.utility)
const decodeBlocks = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
)
test('the compactor preserves channel instructions and tool declarations across corrections', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const faux = fauxProvider({
        tokensPerSecond: Infinity,
        models: [{ id: 'primary' }, { id: 'utility-only' }],
      })
      const models = createModels()
      models.setProvider(faux.provider)
      const utility = decodeUtility({
        provider: 'faux',
        modelId: 'utility-only',
        thinkingLevel: 'medium',
      })
      let sawPreviousAttempt = false
      const prefix = {
        systemPrompt: `Channel policy.\n\n${optChatInstructions}`,
        tools: [
          {
            name: 'zoom',
            description: 'Open memory.',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }
      faux.setResponses([
        async (context, options, _state, model) => {
          expect(model.id).toBe('utility-only')
          expect(options?.reasoning).toBe('medium')
          expect(getCurrentSystemPrompt(context.messages)).toContain(
            'Record faithfully: never answer,',
          )
          expect(getCurrentSystemPrompt(context.messages)).toBe(prefix.systemPrompt)
          expect(getCurrentTools(context.messages)).toEqual(prefix.tools)
          const user = context.messages.find((message) => message.role === 'user')
          const blocks = decodeBlocks(user?.content)
          expect(blocks).toHaveLength(2)
          expect(blocks[0]?.text).toBe('<chat>\nuser: Earlier decision.\n</chat>')
          const prompt = blocks[1]?.text ?? ''
          const scale = prompt.split('the length of this ruler:\n')[1]?.split('\n')[0] ?? ''
          expect(scale).toBe('-'.repeat(512))
          expect(bytes(scale)).toBe(512)
          expect(prompt).toContain('<input>\nuser: Remember Tokyo.')
          return fauxAssistantMessage('東京'.repeat(100))
        },
        async (context) => {
          expect(getCurrentSystemPrompt(context.messages)).toBe(prefix.systemPrompt)
          expect(getCurrentTools(context.messages)).toEqual(prefix.tools)
          sawPreviousAttempt = context.messages.some((message) => message.role === 'assistant')
          return fauxAssistantMessage('user: Keep Tokyo.')
        },
      ])
      const compress = makeOptChatCompressor(models, () => utility, '/tmp')
      expect(
        yield* compress({
          context: '<chat>\nuser: Earlier decision.\n</chat>',
          source: 'user: Remember Tokyo. '.repeat(40),
          merge: false,
          prefix,
        }),
      ).toBe('user: Keep Tokyo.')
      expect(sawPreviousAttempt).toBe(true)
      expect(faux.state.callCount).toBe(2)
    }),
  ))
