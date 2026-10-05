/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function -- Bun and the faux provider are the integration boundary. */
import { test, expect } from 'bun:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { AppConfig } from '../config/AppConfig.ts'
import { makeOptChatCompressor } from './OptChatCompactor.ts'
import { bytes } from './OptChatTree.ts'

const decodeUtility = Schema.decodeUnknownSync(AppConfig.fields.models.fields.utility)
const decodeBlocks = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
)
test('the compactor corrects byte overflow in the same conversation with no tools', () =>
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
      faux.setResponses([
        async (context, options, _state, model) => {
          expect(model.id).toBe('utility-only')
          expect(options?.reasoning).toBe('medium')
          expect(getCurrentSystemPrompt(context.messages)).toContain(
            'Record faithfully: never answer,',
          )
          const user = context.messages.find((message) => message.role === 'user')
          const blocks = decodeBlocks(user?.content)
          expect(blocks).toHaveLength(2)
          expect(blocks[0]?.text).toBe('<chat>\nuser: Earlier decision.\n</chat>')
          const prompt = blocks[1]?.text ?? ''
          const scale =
            prompt.split('For scale, this line is exactly 512 bytes:\n')[1]?.split('\n')[0] ?? ''
          expect(bytes(scale)).toBe(512)
          return fauxAssistantMessage('東京'.repeat(100))
        },
        async (context) => {
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
        }),
      ).toBe('user: Keep Tokyo.')
      expect(sawPreviousAttempt).toBe(true)
      expect(faux.state.callCount).toBe(2)
    }),
  ))
