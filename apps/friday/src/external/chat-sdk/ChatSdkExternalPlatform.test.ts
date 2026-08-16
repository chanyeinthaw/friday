import { assert, it } from '@effect/vitest'
import {
  ExternalBinding,
  type ExternalBinding as ExternalBindingType,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makeChatSdkExternalPlatform } from './ChatSdkExternalPlatform.ts'

const binding: ExternalBindingType = Schema.decodeSync(ExternalBinding)({
  platform: 'discord',
  channelId: 'discord:channel-1',
  sourceMessageId: 'message-1',
  externalThreadId: 'discord:channel-1:message-1',
})

it.effect('publishes final text through the bound Chat SDK thread', () =>
  Effect.gen(function* () {
    const publications: Array<string> = []
    const platform = yield* makeChatSdkExternalPlatform({
      thread: (threadId) => ({
        post: (text) => {
          publications.push(`${threadId}:${text}`)
          return Promise.resolve({})
        },
      }),
    })

    yield* platform.publish({ binding, text: 'Friday is done.' })

    assert.deepStrictEqual(publications, ['discord:channel-1:message-1:Friday is done.'])
  }),
)
