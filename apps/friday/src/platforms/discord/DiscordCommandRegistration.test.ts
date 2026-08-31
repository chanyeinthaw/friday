import { assert, it, vi } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import {
  fridayCommandDefinition,
  registerGlobalFridayCommand,
} from './DiscordCommandRegistration.ts'

const recordFetch = (
  respond: (url: string, method: string) => Response,
): Array<{
  readonly url: RequestInfo
  readonly method: string
  readonly body?: string | undefined
}> => {
  const requests: Array<{
    readonly url: string
    readonly method: string
    readonly body?: string | undefined
  }> = []
  vi.stubGlobal('fetch', (input: string, init?: RequestInit & { readonly body?: string }) => {
    requests.push({ url: input, method: init?.method ?? 'GET', body: init?.body })
    return Promise.resolve(respond(input, init?.method ?? 'GET'))
  })
  return requests
}

it('defines /friday with a reload subcommand payload Discord accepts', () => {
  // SUB_COMMAND options (type 1) must not carry `required`; Discord rejects the payload.
  assert.deepStrictEqual(fridayCommandDefinition, {
    name: 'friday',
    description: 'Friday application commands.',
    options: [
      {
        name: 'reload',
        description: 'Reload Friday configuration from the database.',
        type: 1,
      },
    ],
  })
})

it.effect('creates the command when no global command exists yet', () =>
  Effect.gen(function* () {
    const requests = recordFetch(() => new Response('[]', { status: 200 }))
    yield* registerGlobalFridayCommand({
      botToken: 'bot-token',
      applicationId: 'application-1',
    })
    vi.unstubAllGlobals()

    // One listing read, then a single-command create. No bulk PUT anywhere.
    assert.strictEqual(requests.length, 2)
    const list = requests[0]
    const create = requests[1]
    assert(list !== undefined && create !== undefined)
    assert.strictEqual(list.method, 'GET')
    assert.strictEqual(list.url, 'https://discord.com/api/v10/applications/application-1/commands')
    assert.strictEqual(create.method, 'POST')
    assert.strictEqual(
      create.url,
      'https://discord.com/api/v10/applications/application-1/commands',
    )
    assert.deepStrictEqual(JSON.parse(create.body ?? 'null'), fridayCommandDefinition)
  }),
)

it.effect('updates only the matching command instead of bulk-overwriting', () =>
  Effect.gen(function* () {
    const requests = recordFetch((url, method) =>
      method === 'GET'
        ? new Response(
            JSON.stringify([
              { id: '111', name: 'unrelated' },
              { id: '222', name: 'friday' },
            ]),
            { status: 200 },
          )
        : new Response(JSON.stringify({ id: '222' }), { status: 200 }),
    )
    yield* registerGlobalFridayCommand({
      botToken: 'bot-token',
      applicationId: 'application-1',
    })
    vi.unstubAllGlobals()

    // The existing /friday command is PATCHed by ID; the unrelated command is
    // never deleted or rewritten.
    assert.strictEqual(requests.length, 2)
    const update = requests[1]
    assert(update !== undefined)
    assert.strictEqual(update.method, 'PATCH')
    assert.strictEqual(
      update.url,
      'https://discord.com/api/v10/applications/application-1/commands/222',
    )
    assert.deepStrictEqual(JSON.parse(update.body ?? 'null'), fridayCommandDefinition)
  }),
)

it.effect('fails with a typed error when Discord rejects the registration', () =>
  Effect.gen(function* () {
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      Promise.resolve(
        (init?.method ?? 'GET') === 'GET'
          ? new Response('[]', { status: 200 })
          : new Response('nope', { status: 403 }),
      ),
    )
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
