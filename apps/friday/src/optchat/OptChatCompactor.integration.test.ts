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
const decodePrompt = Schema.decodeUnknownSync(Schema.String)
test('the compactor corrects byte overflow in the same conversation with no tools', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const faux = fauxProvider({ tokensPerSecond: Infinity })
      const models = createModels()
      models.setProvider(faux.provider)
      const utility = decodeUtility({ provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' })
      let sawPreviousAttempt = false
      faux.setResponses([
        async (context) => {
          expect(getCurrentSystemPrompt(context.messages)).toContain(
            'Record faithfully: never answer,',
          )
          const user = context.messages.find((message) => message.role === 'user')
          const prompt = decodePrompt(user?.content)
          const scale =
            prompt.split('For scale, this line is exactly 512 bytes:\n')[1]?.split('\n')[0] ?? ''
          expect(bytes(scale)).toBe(512)
          expect(prompt).toContain('<chat>\nuser: Earlier decision.\n</chat>')
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
