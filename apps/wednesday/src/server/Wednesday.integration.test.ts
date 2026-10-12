import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'
import { Sse } from 'effect/encoding'
import { Database } from 'bun:sqlite'
import { ServerEvent, type ClientCommand, type Thinking } from '../shared/protocol.ts'

const parseReplies = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ServerEvent)))
const parseEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ServerEvent))
const Request = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Unknown),
  stream: Schema.Boolean,
  reasoning_effort: Schema.optionalKey(Schema.String),
})
const parseLegacyView = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ parts: Schema.Array(Schema.Struct({ id: Schema.Int, count: Schema.Int })) }),
  ),
)
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const parseRequest = Schema.decodeUnknownSync(Schema.fromJsonString(Request))
const parseGrant = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ grant_type: Schema.String })),
)
const parseCodexRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      input: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
      tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      instructions: Schema.NonEmptyString,
      store: Schema.Literal(false),
      stream: Schema.Literal(true),
    }),
  ),
)
const parseSettingsRow = Schema.decodeUnknownSync(Schema.Struct({ payload: Schema.String }))
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const issuer = 'https://wednesday-test.clerk.accounts.dev'
const publishableKey = `pk_test_${Buffer.from('wednesday-test.clerk.accounts.dev$').toString('base64')}`
const token = (userId: string, origin: string, lifetime = 3600) => {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test' })).toString(
    'base64url',
  )
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: userId,
      sid: 'sess_test',
      azp: origin,
      iat: now,
      nbf: now - 1,
      exp: now + lifetime,
    }),
  ).toString('base64url')
  const signed = `${header}.${payload}`
  return `${signed}.${createSign('RSA-SHA256').update(signed).sign(privateKey).toString('base64url')}`
}
let temporary = ''
let binary = ''
let application: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
let provider: ReturnType<typeof Bun.serve>
let applicationPort = 0
let deviceApproved = false
let refreshCount = 0
const codexRequests: ReturnType<typeof parseJson>[] = []
const chatGptAccessToken = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url')}.signature`
let requestCount = 0
const requests: unknown[] = []
let memoryResponse: ((raw: string) => Promise<string> | string) | undefined
const memoryRequests: string[] = []
let chatGate: ((body: typeof Request.Type) => Promise<void>) | undefined
let firstRequestResolve: (() => void) | undefined
let firstResponseResolve: (() => void) | undefined
let holdFirstResponse = false
let firstRequest = Promise.resolve()
let firstResponse = Promise.resolve()

const port = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') })
  const selected = probe.port
  void probe.stop(true)
  if (selected === undefined) throw new Error('No test port')
  return selected
}
const startApplication = async () => {
  application = Bun.spawn([binary], {
    cwd: temporary,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CLERK_PUBLISHABLE_KEY: publishableKey,
      CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      WEDNESDAY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      WEDNESDAY_DATABASE: join(temporary, 'test.sqlite'),
      WEDNESDAY_PORT: String(applicationPort),
      WEDNESDAY_ORIGIN: `http://localhost:${applicationPort}`,
      WEDNESDAY_CHATGPT_ISSUER: `http://127.0.0.1:${provider.port}/auth`,
      WEDNESDAY_CHATGPT_BACKEND: `http://127.0.0.1:${provider.port}/codex`,
    },
  })
  const reader = application.stdout.getReader()
  const deadline = setTimeout(() => application.kill(), 10000)
  const output = await reader.read()
  clearTimeout(deadline)
  if (output.done || !new TextDecoder().decode(output.value).includes('listening')) {
    throw new Error(
      `Application startup failed: ${new TextDecoder().decode(output.value)} ${await new Response(application.stderr).text()}`,
    )
  }
  reader.releaseLock()
  const initialized = await fetch(`http://127.0.0.1:${applicationPort}/config`)
  if (!initialized.ok) throw new Error('HTTP API startup failed')
}
class Client {
  readonly events: ServerEvent[] = []
  readonly observed: ServerEvent[] = []
  turnId: string | null = null
  streamId = ''
  initial: Extract<ServerEvent, { _tag: 'Snapshot' }> | undefined
  readonly waiting: {
    predicate: (event: ServerEvent) => boolean
    resolve: (event: ServerEvent) => void
  }[] = []
  readonly abort = new AbortController()
  readonly userId: string
  constructor(userId: string) {
    this.userId = userId
  }
  get closed() {
    return this.abort.signal.aborted
  }
  close() {
    this.abort.abort()
  }
  receive(event: ServerEvent) {
    this.observed.push(event)
    if (event._tag === 'Ready') this.streamId = event.streamId ?? ''
    if (event._tag === 'Status' || event._tag === 'Snapshot') this.turnId = event.turnId
    const match = this.waiting.find((item) => item.predicate(event))
    if (match) {
      this.waiting.splice(this.waiting.indexOf(match), 1)
      match.resolve(event)
    } else this.events.push(event)
  }
  send(command: ClientCommand) {
    const path = {
      Load: '/api/chat',
      Send: '/api/chat/messages',
      Steer: '/api/chat/steering',
      Stop: '/api/chat/stop',
      SaveSettings: '/api/settings',
      DiscoverModels: '/api/models',
      StartChatGpt: '/api/chatgpt/start',
      PollChatGpt: '/api/chatgpt/poll',
      CancelChatGpt: '/api/chatgpt/cancel',
      DisconnectChatGpt: '/api/chatgpt/disconnect',
    }[command._tag]
    const { _tag, ...payload } = command
    void fetch(`http://127.0.0.1:${applicationPort}${path}`, {
      method: _tag === 'Load' ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token(this.userId, `http://localhost:${applicationPort}`)}`,
        'Content-Type': 'application/json',
        Origin: `http://localhost:${applicationPort}`,
      },
      body: _tag === 'Load' ? undefined : JSON.stringify(payload),
    }).then(async (response) => {
      if (!response.ok) {
        this.receive({ _tag: 'Error', message: await response.text() })
        return
      }
      for (const event of parseReplies(await response.text())) this.receive(event)
    })
  }
  wait(predicate: (event: ServerEvent) => boolean): Promise<ServerEvent> {
    const match = this.events.find(predicate)
    if (match) {
      this.events.splice(this.events.indexOf(match), 1)
      return Promise.resolve(match)
    }
    return new Promise((resolve) => this.waiting.push({ predicate, resolve }))
  }
  async snapshot() {
    this.send({ _tag: 'Load' })
    const event = await this.wait((event) => event._tag === 'Snapshot')
    if (event._tag !== 'Snapshot') throw new Error('Expected snapshot')
    return event
  }
}
const connect = async (userId: string, afterId = -1, lifetime = 3600) => {
  const client = new Client(userId)
  const response = await fetch(
    `http://127.0.0.1:${applicationPort}/api/chat/events?afterId=${afterId}`,
    {
      headers: {
        Authorization: `Bearer ${token(userId, `http://localhost:${applicationPort}`, lifetime)}`,
        Origin: `http://localhost:${applicationPort}`,
      },
      signal: client.abort.signal,
    },
  )
  if (!response.ok || !response.body) throw new Error(`SSE connection failed: ${response.status}`)
  const reader = response.body.getReader()
  const parser = Sse.makeParser((event) => {
    if (event._tag !== 'Retry') client.receive(parseEvent(event.data))
  })
  void (async () => {
    const decoder = new TextDecoder()
    while (!client.closed) {
      const chunk = await reader.read()
      if (chunk.done) break
      parser.feed(decoder.decode(chunk.value, { stream: true }))
    }
  })().catch(() => {})
  await client.wait((event) => event._tag === 'Ready')
  const snapshot = await client.wait((event) => event._tag === 'Snapshot')
  if (snapshot._tag === 'Snapshot') client.initial = snapshot
  return client
}
const save = async (client: Client, memoryModelId = '', memoryThinking: Thinking = 'off') => {
  client.send({
    _tag: 'SaveSettings',
    apiKey: 'test-provider-secret',
    settings: {
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      modelId: 'test-model',
      memoryModelId,
      memoryThinking,
      thinking: 'high',
      models: [
        {
          id: 'memory-model',
          contextWindow: 128000,
          maxOutputTokens: 8192,
          requestFields: {},
          thinking: { off: {}, low: { reasoning_effort: 'low' } },
        },
        {
          id: 'test-model',
          contextWindow: 128000,
          maxOutputTokens: 8192,
          requestFields: {},
          thinking: { off: {}, high: { reasoning_effort: 'high' } },
        },
      ],
    },
  })
  const saved = await client.wait((event) => event._tag === 'Saved' || event._tag === 'Error')
  expect(saved._tag).toBe('Saved')
}
test('embedded assets negotiate compression and immutable caching', async () => {
  const origin = `http://127.0.0.1:${applicationPort}`
  const page = await fetch(origin)
  expect(page.headers.get('cache-control')).toBe('no-cache')
  const html = await page.text()
  const script = html.match(/src="([^" ]+\.js)"/)?.[1]
  if (!script) throw new Error('Missing frontend script')
  const plain = await fetch(new URL(script, origin), { headers: { 'accept-encoding': 'identity' } })
  const plainBody = await plain.text()
  for (const encoding of ['br', 'gzip']) {
    const compressed = await fetch(new URL(script, origin), {
      headers: { 'accept-encoding': encoding },
    })
    expect(compressed.headers.get('content-encoding')).toBe(encoding)
    expect(compressed.headers.get('vary')).toContain('Accept-Encoding')
    expect(compressed.headers.get('cache-control')).toContain('immutable')
    expect(Number(compressed.headers.get('content-length'))).toBeLessThan(plainBody.length / 2)
    expect(await compressed.text()).toBe(plainBody)
  }
  for (const path of ['/settings', '/waitlist'])
    expect((await fetch(origin + path)).status).toBe(200)
})
const deviceProvider = async (request: Request) => {
  const path = new URL(request.url).pathname
  if (path === '/auth/api/accounts/deviceauth/usercode')
    return Response.json({
      device_auth_id: 'device-test',
      user_code: 'TEST-CODE',
      interval: '1',
    })
  if (path === '/auth/api/accounts/deviceauth/token')
    return deviceApproved
      ? Response.json({
          authorization_code: 'authorization-test',
          code_verifier: 'verifier-test',
        })
      : new Response('', { status: 403 })
  if (path === '/auth/oauth/token') {
    const body = parseGrant(await request.text())
    if (body.grant_type === 'refresh_token') refreshCount++
    return Response.json({
      access_token: chatGptAccessToken,
      refresh_token: 'refresh-test-secret',
      expires_in: body.grant_type === 'refresh_token' ? 3600 : 0,
    })
  }
  if (path === '/codex/models') {
    expect(new URL(request.url).searchParams.get('client_version')).toBe('0.160.0')
    expect(request.headers.get('originator')).toBe('codex_cli_rs')
    return Response.json({
      models: [
        {
          slug: 'codex-model',
          display_name: 'Codex model',
          visibility: 'list',
          supported_in_api: true,
          context_window: 128000,
          supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }],
        },
        { slug: 'codex-auto-review', visibility: 'hide', supported_in_api: true },
        { slug: 'unsupported-model', visibility: 'list', supported_in_api: false },
      ],
    })
  }
  if (path === '/codex/responses') {
    expect(request.headers.get('ChatGPT-Account-Id')).toBe('account-test')
    expect(request.headers.get('Authorization')).toBe(`Bearer ${chatGptAccessToken}`)
    const body = parseCodexRequest(await request.text())
    codexRequests.push(body)
    const callsDate =
      body.tools?.some((tool) => tool.name === 'date') &&
      !body.input.some((item) => item.type === 'function_call_output')
    const output = callsDate
      ? [
          {
            type: 'function_call',
            id: 'fc_date',
            call_id: 'call_date',
            name: 'date',
            arguments: '{}',
            status: 'completed',
          },
        ]
      : [
          {
            type: 'message',
            role: 'assistant',
            id: 'msg_codex',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Hello from ChatGPT', annotations: [] }],
          },
        ]
    const response = {
      id: 'resp_codex',
      object: 'response',
      created_at: 1,
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: body.instructions,
      model: 'codex-model',
      output,
      parallel_tool_calls: false,
      previous_response_id: null,
      reasoning: { effort: 'none', summary: null },
      store: false,
      temperature: 1,
      text: { format: { type: 'text' } },
      tool_choice: 'auto',
      tools: [],
      top_p: 1,
      truncation: 'disabled',
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        total_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      user: null,
      metadata: {},
    }
    const item = output[0]
    const events = [
      {
        type: 'response.created',
        response: { ...response, status: 'in_progress', output: [] },
      },
      { type: 'response.output_item.added', output_index: 0, item },
      ...(callsDate
        ? [
            {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              item_id: 'fc_date',
              delta: '{}',
            },
            {
              type: 'response.function_call_arguments.done',
              output_index: 0,
              item_id: 'fc_date',
              arguments: '{}',
            },
          ]
        : [
            {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              item_id: 'msg_codex',
              delta: 'Hello from ChatGPT',
            },
          ]),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]
    return new Response(
      events
        .map(
          (event, sequence_number) =>
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
        )
        .join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  return undefined
}
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'wednesday-test-'))
  binary = join(temporary, 'wednesday')
  const build = Bun.spawn(['bun', 'build', './src/main.ts', '--compile', '--outfile', binary], {
    cwd: join(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await build.exited).toBe(0)
  applicationPort = port()
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const deviceResponse = await deviceProvider(request)
      if (deviceResponse) return deviceResponse
      if (new URL(request.url).pathname === '/v1/models')
        return Response.json({ data: [{ id: 'test-model' }] })
      const raw = await request.text()
      const body = parseRequest(raw)
      requests.push(parseJson(raw))
      const currentRequest = ++requestCount
      if (chatGate && body.model === 'test-model') await chatGate(body)
      const content =
        body.model === 'memory-model' && memoryResponse
          ? await memoryResponse(raw)
          : 'A saved reply.'
      if (body.model === 'memory-model') memoryRequests.push(raw)
      if (holdFirstResponse && currentRequest === 1) {
        firstRequestResolve?.()
        await firstResponse
      }
      const tool = holdFirstResponse && currentRequest === 1
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'call_date',
                type: 'function',
                function: { name: 'date', arguments: '{"id":0}' },
              },
            ],
          }
        : { content }
      const chunk = {
        id: `chat_${requestCount}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }],
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  await startApplication()
}, 20000)
afterAll(async () => {
  application?.kill()
  await application?.exited
  await provider?.stop(true)
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

test('compiled binary embeds frontend and rejects cross-origin HTTP requests', async () => {
  const html = await fetch(`http://127.0.0.1:${applicationPort}/`).then((response) =>
    response.text(),
  )
  expect(html).toContain('<title>Wednesday</title>')
  const script = html.match(/src="([^"]+\.js)"/)
  expect(script?.[1]).toBeDefined()
  const asset = await fetch(`http://127.0.0.1:${applicationPort}${script?.[1]}`).then((response) =>
    response.text(),
  )
  expect(asset.includes('Steer this response')).toBe(true)
  const denied = await fetch(`http://127.0.0.1:${applicationPort}/api/chat`, {
    headers: {
      Origin: 'https://untrusted.example',
      Authorization: `Bearer ${token('user-a', `http://localhost:${applicationPort}`)}`,
    },
  })
  expect(denied.status).toBe(401)
})

test('rejects an expired request and accepts a fresh Clerk token', async () => {
  const origin = `http://localhost:${applicationPort}`
  const expired = token('user_renewal', origin, 1)
  await Bun.sleep(1100)
  const rejected = await fetch(`http://127.0.0.1:${applicationPort}/api/chat`, {
    headers: { Authorization: `Bearer ${expired}`, Origin: origin },
  })
  expect(rejected.status).toBe(401)
  const refreshed = await connect('user_renewal')
  expect((await refreshed.snapshot()).messages).toEqual([])
  refreshed.close()
}, 10000)

test('persists private conversations, consumes steering on the next model step, and deduplicates in memory while preserving history across restart', async () => {
  const chan = await connect('user_chan')
  const pinn = await connect('user_pinn')
  await save(chan)
  expect((await pinn.snapshot()).settings).toBeNull()
  firstRequest = new Promise((resolve) => {
    firstRequestResolve = resolve
  })
  firstResponse = new Promise((resolve) => {
    firstResponseResolve = resolve
  })
  holdFirstResponse = true
  chan.send({ _tag: 'Send', requestId: 'request_first', text: 'Remember this decision.' })
  await firstRequest
  await chan.wait((event) => event._tag === 'Accepted' && event.requestId === 'request_first')
  chan.send({ _tag: 'Send', requestId: 'request_steer', text: 'Also remember my correction.' })
  const steering = await chan.wait(
    (event) => event._tag === 'Accepted' && event.requestId === 'request_steer',
  )
  expect(steering._tag === 'Accepted' && steering.mode).toBe('steer')
  firstResponseResolve?.()
  await chan.wait((event) => event._tag === 'Status' && !event.busy)
  const history = await chan.snapshot()
  expect(
    history.messages.filter((message) => message.kind === 'user').map((message) => message.text),
  ).toEqual(['Remember this decision.', 'Also remember my correction.'])
  expect(history.messages.some((message) => message.kind === 'talk')).toBe(true)
  expect(JSON.stringify(requests[1])).toContain('Also remember my correction.')
  expect(JSON.stringify(requests[0])).toContain('reasoning_effort')
  expect((await pinn.snapshot()).messages).toEqual([])
  const database = new Database(join(temporary, 'test.sqlite'), { readonly: true })
  const row = database
    .query<{ payload: string }, []>('SELECT payload FROM wednesday_settings')
    .get()
  expect(row?.payload).not.toContain('test-provider-secret')
  database.close()
  const countBeforeDuplicate = requestCount
  chan.send({ _tag: 'Send', requestId: 'request_first', text: 'Remember this decision.' })
  await chan.wait((event) => event._tag === 'Accepted' && event.requestId === 'request_first')
  expect(requestCount).toBe(countBeforeDuplicate)
  chan.close()
  pinn.close()
  application.kill()
  await application.exited
  await startApplication()
  const resumed = await connect('user_chan')
  expect((await resumed.snapshot()).messages).toEqual(history.messages)
  const count = requestCount
  resumed.send({ _tag: 'Send', requestId: 'request_first', text: 'Remember this decision.' })
  await resumed.wait((event) => event._tag === 'Accepted')
  await resumed.wait((event) => event._tag === 'Status' && !event.busy)
  expect(requestCount).toBeGreaterThan(count)
  resumed.send({ _tag: 'Send', requestId: 'request_next', text: 'What did we decide?' })
  await resumed.wait((event) => event._tag === 'Status' && !event.busy)
  expect(JSON.stringify(requests.at(-1))).toContain('user: Remember this decision.')
  resumed.close()
}, 20000)

const holdChat = () => {
  let startedResolve: (() => void) | undefined
  let releaseResolve: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve
  })
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve
  })
  let first = true
  chatGate = async () => {
    if (!first) return
    first = false
    startedResolve?.()
    await released
  }
  return {
    started,
    release: () => {
      releaseResolve?.()
      chatGate = undefined
    },
  }
}

test('synchronizes settings, busy, pending steering, and Stop between tabs', async () => {
  const first = await connect('user_tabs')
  const second = await connect('user_tabs')
  await save(first)
  expect((await second.wait((event) => event._tag === 'SettingsChanged'))._tag).toBe(
    'SettingsChanged',
  )
  const gate = holdChat()
  first.send({ _tag: 'Send', requestId: 'tabs-turn', text: 'Initial thought' })
  await gate.started
  await second.wait((event) => event._tag === 'Status' && event.busy)
  first.send({ _tag: 'Steer', requestId: 'tabs-steer', text: 'Correction', turnId: 'tabs-turn' })
  const pending = await second.wait(
    (event) =>
      event._tag === 'Status' && event.pending.some((item) => item.requestId === 'tabs-steer'),
  )
  expect(pending._tag === 'Status' && pending.turnId).toBe('tabs-turn')
  const current = await second.snapshot()
  const third = await connect('user_tabs', current.messages.at(-1)?.id ?? -1)
  expect(third.initial?.messages).toEqual([])
  expect(third.initial?.pending?.map((item) => item.requestId)).toContain('tabs-steer')
  second.send({ _tag: 'Stop', turnId: 'tabs-turn' })
  await first.wait((event) => event._tag === 'Discarded' && event.requestIds.includes('tabs-steer'))
  await third.wait((event) => event._tag === 'Status' && !event.busy)
  gate.release()
  expect((await first.snapshot()).pending).toEqual([])
  expect((await first.snapshot()).messages.some((item) => item.text === 'Correction')).toBe(false)
  first.close()
  second.close()
  third.close()
}, 10000)

test('discards unused steering and rejects steering for an ended turn', async () => {
  const client = await connect('user_discard')
  await save(client)
  const gate = holdChat()
  client.send({ _tag: 'Send', requestId: 'discard-turn', text: 'One complete response' })
  await gate.started
  client.send({
    _tag: 'Steer',
    requestId: 'discard-steer',
    text: 'Unused correction',
    turnId: 'discard-turn',
  })
  await client.wait((event) => event._tag === 'Accepted' && event.requestId === 'discard-steer')
  const count = requestCount
  gate.release()
  await client.wait(
    (event) => event._tag === 'Discarded' && event.requestIds.includes('discard-steer'),
  )
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  const history = await client.snapshot()
  expect(history.messages.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual([
    'One complete response',
  ])
  expect(requestCount).toBe(count)
  expect(client.observed.every((event) => String(event._tag) !== 'Delta')).toBe(true)
  const lastId = history.messages.at(-1)?.id ?? -1
  client.close()
  const reconnect = await connect('user_discard', 0)
  expect(reconnect.initial?.messages.map((item) => item.id)).toEqual([lastId])
  expect(reconnect.initial?.messages[0]?.text).toBe('A saved reply.')
  reconnect.send({
    _tag: 'Steer',
    requestId: 'stale-steer',
    text: 'Too late',
    turnId: 'discard-turn',
  })
  expect((await reconnect.wait((event) => event._tag === 'Error'))._tag).toBe('Error')
  expect((await reconnect.snapshot()).busy).toBe(false)
  reconnect.close()
}, 10000)

test('renews authorization without reconnecting and rejects another user’s stream renewal', async () => {
  const client = await connect('user_long_stream', -1, 2)
  const origin = `http://localhost:${applicationPort}`
  const renew = (userId: string) =>
    fetch(`http://127.0.0.1:${applicationPort}/api/chat/events/renew`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token(userId, origin)}`,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ streamId: client.streamId }),
    })
  expect((await renew('user_other')).status).toBe(400)
  expect((await renew(client.userId)).status).toBe(200)
  await client.wait((event) => event._tag === 'Heartbeat')
  await client.wait((event) => event._tag === 'Heartbeat')
  expect(client.observed.filter((event) => event._tag === 'Ready')).toHaveLength(1)
  expect((await client.snapshot()).messages).toEqual([])
  client.close()
}, 25000)

test('forgets active turns and pending steering on restart while retaining settings and history', async () => {
  const client = await connect('user_runtime_restart')
  await save(client)
  const gate = holdChat()
  client.send({ _tag: 'Send', requestId: 'restart-turn', text: 'Keep the original message' })
  await gate.started
  await client.wait((event) => event._tag === 'Accepted' && event.requestId === 'restart-turn')
  client.send({
    _tag: 'Steer',
    requestId: 'restart-steer',
    text: 'Lose this pending correction',
    turnId: 'restart-turn',
  })
  await client.wait((event) => event._tag === 'Accepted' && event.requestId === 'restart-steer')
  const before = await client.snapshot()
  expect(before.pending?.map((item) => item.requestId)).toContain('restart-steer')
  client.close()
  application.kill()
  await application.exited
  gate.release()
  await startApplication()
  const resumed = await connect(client.userId)
  expect(resumed.initial?.busy).toBe(false)
  expect(resumed.initial?.turnId).toBeNull()
  expect(resumed.initial?.pending).toEqual([])
  expect(resumed.initial?.messages).toEqual(before.messages)
  expect(resumed.initial?.settings).toEqual(before.settings)
  const database = new Database(join(temporary, 'test.sqlite'), { readonly: true })
  expect(
    database.query('SELECT name FROM sqlite_master WHERE name="wednesday_submissions"').get(),
  ).toBeNull()
  database.close()
  resumed.send({ _tag: 'Send', requestId: 'restart-next', text: 'Start a new response' })
  await resumed.wait((event) => event._tag === 'Status' && !event.busy)
  expect(
    (await resumed.snapshot()).messages.some(
      (item) => item.text === 'Lose this pending correction',
    ),
  ).toBe(false)
  resumed.close()
}, 10000)

test('compacts in the background with eight calls, bounded source context, and a separate model', async () => {
  const client = await connect('user_memory')
  await save(client, 'memory-model', 'low')
  let inflight = 0
  let peak = 0
  let started = 0
  let eightStartedResolve: (() => void) | undefined
  const eightStarted = new Promise<void>((resolve) => {
    eightStartedResolve = resolve
  })
  let releaseResolve: (() => void) | undefined
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve
  })
  memoryResponse = async () => {
    inflight++
    peak = Math.max(peak, inflight)
    started++
    if (started === 8) eightStartedResolve?.()
    if (started <= 8) await release
    inflight--
    return 'user: preserve the decision. ' + 'x'.repeat(320)
  }
  const text = '🪷'.repeat(30_000 * 8 + 10)
  client.send({ _tag: 'Send', requestId: 'large_unicode', text })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  // The chat finished while eight compactions were still waiting on the provider.
  await eightStarted
  expect(inflight).toBe(8)
  expect(
    memoryRequests.slice(-8).every((raw) => parseRequest(raw).reasoning_effort === 'low'),
  ).toBe(true)
  releaseResolve?.()
  client.send({ _tag: 'Send', requestId: 'after_compaction', text: 'What did I tell you?' })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  expect(peak).toBe(8)
  const history = await client.snapshot()
  const pages = history.messages.filter(
    (message) => message.kind === 'user' && message.text !== 'What did I tell you?',
  )
  expect(pages.map((message) => message.text).join('')).toBe(text)
  expect(pages).toHaveLength(9)
  const merges = memoryRequests.filter((raw) => raw.includes('Compaction: merge lines'))
  expect(merges.length).toBeGreaterThan(0)
  expect(merges.some((raw) => raw.includes('0+1|') && raw.includes('1+1|'))).toBe(true)
  expect(memoryRequests.every((raw) => !raw.includes('(not summarized yet: zoom it)'))).toBe(true)
  const database = new Database(join(temporary, 'test.sqlite'), { readonly: true })
  expect(
    database
      .query<{ count: number }, []>(
        'SELECT count(*) AS count FROM wednesday_memory_nodes WHERE user_id="user_memory" AND count=1',
      )
      .get()?.count,
  ).toBeGreaterThanOrEqual(10)
  database.close()
  memoryResponse = undefined
  client.close()
}, 20000)

test('keeps successful summaries and retries failed work on a later message', async () => {
  const client = await connect('user_memory_failure')
  await save(client, 'memory-model')
  memoryResponse = () => ''
  client.send({
    _tag: 'Send',
    requestId: 'fail_summary',
    text: 'Keep this original decision. ' + 'q'.repeat(800),
  })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  const database = new Database(join(temporary, 'test.sqlite'), { readonly: true })
  const failed = database.query<{ count: number }, []>(
    'SELECT count(*) AS count FROM wednesday_memory_jobs WHERE user_id="user_memory_failure" AND status="failed"',
  )
  const deadline = Date.now() + 5000
  while ((failed.get()?.count ?? 0) === 0 && Date.now() < deadline) await Bun.sleep(10)
  expect(failed.get()?.count).toBeGreaterThan(0)
  const ready = database
    .query<{ text: string }, []>(
      'SELECT text FROM wednesday_memory_nodes WHERE user_id="user_memory_failure" AND id=1 AND count=1',
    )
    .get()
  expect(ready?.text).toContain('A saved reply.')
  memoryResponse = () => 'user: Keep this original decision.'
  client.send({ _tag: 'Send', requestId: 'retry_summary', text: 'Continue.' })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  const history = await client.snapshot()
  expect(
    history.messages.filter((message) => message.kind === 'user').map((message) => message.text),
  ).toEqual(['Keep this original decision. ' + 'q'.repeat(800), 'Continue.'])
  expect(
    database
      .query<{ text: string }, []>(
        'SELECT text FROM wednesday_memory_nodes WHERE user_id="user_memory_failure" AND id=1 AND count=1',
      )
      .get(),
  ).toEqual(ready)
  expect(
    database
      .query<{ text: string }, []>(
        'SELECT text FROM wednesday_memory_nodes WHERE user_id="user_memory_failure" AND id=0 AND count=1',
      )
      .get()?.text,
  ).toBe('user: Keep this original decision.')
  database.close()
  memoryResponse = undefined
  client.close()
}, 10000)

test('upgrades legacy memory without rebuilding its saved view or summaries', async () => {
  application.kill()
  await application.exited
  const database = new Database(join(temporary, 'test.sqlite'))
  database.exec(
    'DROP TABLE wednesday_memory_views; DROP TABLE wednesday_memory_nodes; DROP TABLE wednesday_memory_jobs; DELETE FROM wednesday_migrations WHERE version=2;',
  )
  const legacy = {
    parts: [{ id: 0, count: 2 }],
    nodes: [
      { id: 0, count: 1, text: 'user: legacy name' },
      { id: 1, count: 1, text: 'talk: legacy reply' },
      { id: 0, count: 2, text: 'user: legacy name; talk: legacy reply' },
    ],
    pending: false,
  }
  database
    .query('INSERT INTO wednesday_memory (user_id,payload) VALUES (?,?)')
    .run('user_legacy', JSON.stringify(legacy))
  database
    .query('INSERT INTO wednesday_messages (user_id,id,kind,text,date) VALUES (?,?,?,?,?)')
    .run('user_legacy', 0, 'user', 'legacy name', '2026-10-01T00:00:00Z')
  database
    .query('INSERT INTO wednesday_messages (user_id,id,kind,text,date) VALUES (?,?,?,?,?)')
    .run('user_legacy', 1, 'talk', 'legacy reply', '2026-10-01T00:00:01Z')
  database.close()
  await startApplication()
  const upgraded = new Database(join(temporary, 'test.sqlite'), { readonly: true })
  const row = upgraded
    .query<{ payload: string }, []>(
      'SELECT payload FROM wednesday_memory_views WHERE user_id="user_legacy"',
    )
    .get()
  const view = parseLegacyView(row?.payload)
  expect(view.parts).toEqual(legacy.parts)
  expect(
    upgraded
      .query<{ text: string }, []>(
        'SELECT text FROM wednesday_memory_nodes WHERE user_id="user_legacy" AND id=0 AND count=2',
      )
      .get()?.text,
  ).toBe(legacy.nodes[2]?.text)
  expect(
    upgraded
      .query<{ count: number }, []>(
        'SELECT count(*) AS count FROM wednesday_memory_jobs WHERE user_id="user_legacy"',
      )
      .get()?.count,
  ).toBe(0)
  upgraded.close()
}, 10000)

test('scopes device sign-in to its user and cancels unapproved attempts', async () => {
  deviceApproved = false
  const alice = await connect('user_device_alice')
  const bob = await connect('user_device_bob')
  alice.send({ _tag: 'StartChatGpt' })
  const started = await alice.wait((event) => event._tag === 'ChatGptAuthorization')
  if (started._tag !== 'ChatGptAuthorization') throw new Error('Missing code')
  const attemptId = started.authorization.attemptId
  expect(started.authorization.userCode).toBe('TEST-CODE')
  bob.send({ _tag: 'PollChatGpt', attemptId })
  expect((await bob.wait((event) => event._tag === 'Error'))._tag).toBe('Error')
  alice.send({ _tag: 'PollChatGpt', attemptId })
  await alice.wait((event) => event._tag === 'ChatGptPending')
  alice.send({ _tag: 'CancelChatGpt', attemptId })
  await alice.wait((event) => event._tag === 'ChatGptCancelled')
  alice.send({ _tag: 'PollChatGpt', attemptId })
  await alice.wait((event) => event._tag === 'Error')
  expect((await alice.snapshot()).settings).toBeNull()
  alice.close()
  bob.close()
})

test('encrypts ChatGPT tokens, refreshes them, runs OptChat tools over Responses SSE, and disconnects without deleting history', async () => {
  deviceApproved = true
  const client = await connect('user_device_complete')
  client.send({ _tag: 'StartChatGpt' })
  const started = await client.wait((event) => event._tag === 'ChatGptAuthorization')
  if (started._tag !== 'ChatGptAuthorization') throw new Error('Missing code')
  client.send({ _tag: 'PollChatGpt', attemptId: started.authorization.attemptId })
  const connected = await client.wait((event) => event._tag === 'ChatGptConnected')
  if (connected._tag !== 'ChatGptConnected') throw new Error('Missing settings')
  await client.wait((event) => event._tag === 'Snapshot' && event.settings?.provider === 'chatgpt')
  expect(connected.settings.provider).toBe('chatgpt')
  expect(connected.settings.models.map((model) => model.id)).toEqual(['codex-model'])
  expect(connected.settings.models[0]?.displayName).toBe('Codex model')
  const database = new Database(join(temporary, 'test.sqlite'), { readonly: true })
  const row = parseSettingsRow(
    database
      .query('SELECT payload FROM wednesday_settings WHERE user_id="user_device_complete"')
      .get(),
  )
  expect(row.payload).not.toContain('refresh-test-secret')
  expect(row.payload).not.toContain(chatGptAccessToken)
  database.close()
  client.send({ _tag: 'Send', requestId: 'chatgpt-turn', text: 'Hello, what is the date?' })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  const history = await client.snapshot()
  expect(client.observed.filter((event) => event._tag === 'Error')).toEqual([])
  expect(
    history.messages.map((message) => ({ kind: message.kind, text: message.text })),
  ).toContainEqual({ kind: 'talk', text: 'Hello from ChatGPT' })
  expect(
    history.messages.some((message) => message.kind === 'tool' && message.text.includes('date')),
  ).toBe(true)
  expect(refreshCount).toBe(1)
  expect(codexRequests.length).toBeGreaterThanOrEqual(2)
  client.send({ _tag: 'DisconnectChatGpt' })
  const disconnected = await client.wait((event) => event._tag === 'Snapshot' && !event.hasApiKey)
  if (disconnected._tag !== 'Snapshot') throw new Error('Missing snapshot')
  expect(disconnected.settings?.provider).toBe('api')
  expect(disconnected.messages).toHaveLength(history.messages.length)
  client.close()
}, 10000)
