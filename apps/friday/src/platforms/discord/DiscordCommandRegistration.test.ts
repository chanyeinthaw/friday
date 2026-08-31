import { assert, it, vi } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import {
  fridayCommandDefinition,
  registerGlobalFridayCommand,
} from './DiscordCommandRegistration.ts'

it('defines /friday with a required reload subcommand', () => {
  assert.deepStrictEqual(fridayCommandDefinition, {
    name: 'friday',
    description: 'Friday application commands.',
    options: [
      {
        name: 'reload',
        description: 'Reload Friday configuration from the database.',
        type: 1,
        required: true,
      },
    ],
  })
})

it.effect('registers the command globally with the application', () =>
  Effect.gen(function* () {
    // The registration call always sends a JSON string body.
    const requests: Array<{
      readonly url: RequestInfo
      readonly init: RequestInit & { readonly body?: string }
    }> = []
    vi.stubGlobal(
      'fetch',
      (input: RequestInfo, init?: RequestInit & { readonly body?: string }) => {
        requests.push({ url: input, init: init ?? {} })
        return Promise.resolve(new Response('[]', { status: 200 }))
      },
    )
    yield* registerGlobalFridayCommand({
      botToken: 'bot-token',
      applicationId: 'application-1',
    })
    vi.unstubAllGlobals()

    assert.strictEqual(requests.length, 1)
    const request = requests[0]
    assert(request)
    assert.strictEqual(
      request.url,
      'https://discord.com/api/v10/applications/application-1/commands',
    )
    assert.strictEqual(request.init.method, 'PUT')
    assert.deepStrictEqual(request.init.headers, {
      Authorization: 'Bot bot-token',
      'Content-Type': 'application/json',
    })
    assert.deepStrictEqual(JSON.parse(request.init.body ?? 'null'), [fridayCommandDefinition])
  }),
)

it.effect('fails with a typed error when Discord rejects the registration', () =>
  Effect.gen(function* () {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 403 })))
    const error = yield* registerGlobalFridayCommand({
      botToken: 'bot-token',
      applicationId: 'application-1',
    }).pipe(
      Effect.flip,
      Effect.ensuring(
        Effect.sync(() => {
          vi.unstubAllGlobals()
        }),
      ),
    )
    assert.strictEqual(error._tag, 'DiscordCommandRegistrationError')
    assert.match(error.detail, /HTTP 403/)
  }),
)
