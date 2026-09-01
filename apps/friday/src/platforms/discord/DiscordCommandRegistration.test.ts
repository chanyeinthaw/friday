import { assert, it, vi } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import {
  fridayCommandDefinition,
  globalCommandDefinitions,
  registerGlobalDiscordCommands,
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

it('defines /friday and /harness with reload subcommand payloads Discord accepts', () => {
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
  assert.deepStrictEqual(globalCommandDefinitions[1], {
    name: 'harness',
    description: 'Friday harness commands.',
    options: [
      {
        name: 'reload',
        description: 'Reload the harness extensions for this thread.',
        type: 1,
      },
    ],
  })
})

it.effect('creates the command when no global command exists yet', () =>
  Effect.gen(function* () {
    const requests = recordFetch(() => new Response('[]', { status: 200 }))
    yield* registerGlobalDiscordCommands({
      botToken: 'bot-token',
      applicationId: 'application-1',
    })
    vi.unstubAllGlobals()

    // One listing read, then one single-command create per definition. No bulk
    // PUT anywhere.
    assert.strictEqual(requests.length, 3)
    const list = requests[0]
    const creates = requests.slice(1)
    assert(list !== undefined)
    assert.strictEqual(list.method, 'GET')
    assert.strictEqual(list.url, 'https://discord.com/api/v10/applications/application-1/commands')
    assert.deepStrictEqual(
      creates.map((request) => JSON.parse(request.body ?? 'null')),
      globalCommandDefinitions,
    )
    for (const create of creates) {
      assert.strictEqual(create.method, 'POST')
      assert.strictEqual(
        create.url,
        'https://discord.com/api/v10/applications/application-1/commands',
      )
    }
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
    yield* registerGlobalDiscordCommands({
      botToken: 'bot-token',
      applicationId: 'application-1',
    })
    vi.unstubAllGlobals()

    // The existing /friday command is PATCHed by ID; the unrelated command is
    // never deleted or rewritten, and the missing /harness command is created.
    assert.strictEqual(requests.length, 3)
    const update = requests[1]
    assert(update !== undefined)
    assert.strictEqual(update.method, 'PATCH')
    assert.strictEqual(
      update.url,
      'https://discord.com/api/v10/applications/application-1/commands/222',
    )
    assert.deepStrictEqual(JSON.parse(update.body ?? 'null'), fridayCommandDefinition)
    const createHarness = requests[2]
    assert(createHarness !== undefined)
    assert.strictEqual(createHarness.method, 'POST')
    assert.deepStrictEqual(JSON.parse(createHarness.body ?? 'null'), globalCommandDefinitions[1])
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
    const error = yield* registerGlobalDiscordCommands({
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
