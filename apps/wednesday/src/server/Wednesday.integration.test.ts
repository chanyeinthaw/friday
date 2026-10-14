import { zstdDecompressSync } from 'node:zlib'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'
import { Sse } from 'effect/encoding'
import { Database } from 'bun:sqlite'
import { Attachment, PreparedUpload, AttachmentDownload } from '../shared/Attachments.ts'
import { MemorySnapshot, MemoryOriginal } from '../shared/Memory.ts'
import { turnInstructions, compactionInstructions } from './OptChat.ts'
import { ServerEvent, type ClientCommand, type Thinking } from '../shared/protocol.ts'

const completionDelta = (tool: boolean, attachmentTool: boolean, content: string) => {
  return tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: attachmentTool ? 'call_attachment_bash' : 'call_date',
            type: 'function',
            function: attachmentTool
              ? {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command: "rg 'private attachment' /attachments",
                  }),
                }
              : { name: 'date', arguments: '{"id":0}' },
          },
        ],
      }
    : { content }
}

const parsePreparedUpload = Schema.decodeUnknownSync(Schema.fromJsonString(PreparedUpload))
const parseAttachment = Schema.decodeUnknownSync(Schema.fromJsonString(Attachment))
const parseAttachmentDownload = Schema.decodeUnknownSync(Schema.fromJsonString(AttachmentDownload))
const parseMemoryOriginal = Schema.decodeUnknownSync(Schema.fromJsonString(MemoryOriginal))
const parseManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      short_name: Schema.String,
      start_url: Schema.String,
      scope: Schema.String,
      display: Schema.String,
      theme_color: Schema.String,
      icons: Schema.Array(
        Schema.Struct({
          src: Schema.String,
          sizes: Schema.String,
          type: Schema.String,
          purpose: Schema.String,
        }),
      ),
    }),
  ),
)
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
const parseResponsesRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      input: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
      tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      instructions: Schema.optionalKey(Schema.String),
      stream: Schema.Boolean,
    }),
  ),
)
const parseAnthropicMessages = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      role: Schema.String,
      content: Schema.Array(Schema.Struct({ type: Schema.String })),
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
const formatRequests: {
  format: string
  body: Record<string, Schema.Json>
  sessionId: string | null
}[] = []
const decodeObject = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)
const userMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal('user'),
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
    ]),
  }),
)
const isStringContent = Schema.is(Schema.String)
const compactionMessage = (message: Schema.Json) => {
  const decoded = userMessage(message)
  if (decoded._tag === 'None') return false
  const content = decoded.value.content
  return isStringContent(content)
    ? content.startsWith('Compaction:')
    : content.some((part) => part.text?.startsWith('Compaction:'))
}
const isCompactionRequest = (body: Record<string, Schema.Json>) => {
  const messages = body.input ?? body.messages
  return Array.isArray(messages) && messages.some(compactionMessage)
}
const codexRequests: ReturnType<typeof parseJson>[] = []
const chatGptAccessToken = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url')}.signature`
let requestCount = 0
const requests: unknown[] = []
const testObjects = new Map<string, { bytes: Uint8Array; type: string }>()
const objectRequest = async (request: Request) => {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/friday-test/')) return
  if (request.method === 'PUT') {
    testObjects.set(url.pathname, {
      bytes: new Uint8Array(await request.arrayBuffer()),
      type: request.headers.get('content-type') ?? 'application/octet-stream',
    })
    return new Response(null, { headers: { etag: '"test-etag"' } })
  }
  if (request.method === 'DELETE') {
    testObjects.delete(url.pathname)
    return new Response(null, { status: 204 })
  }
  const object = testObjects.get(url.pathname)
  if (!object) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
  const headers = {
    'content-type': object.type,
    'content-length': String(object.bytes.length),
    etag: '"test-etag"',
    'last-modified': new Date().toUTCString(),
  }
  if (request.method === 'HEAD') return new Response(null, { headers })
  const range = request.headers.get('range')?.match(/bytes=(\d+)-(\d+)/)
  if (range) {
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), object.bytes.length - 1)
    const bytes = object.bytes.slice(start, end + 1)
    return new Response(bytes, {
      status: 206,
      headers: {
        ...headers,
        'content-length': String(bytes.length),
        'content-range': `bytes ${start}-${end}/${object.bytes.length}`,
      },
    })
  }
  return new Response(object.bytes, { headers })
}

let memoryResponse: ((raw: string) => Promise<string> | string) | undefined
const memoryRequests: string[] = []
let streamingGate: { resume: Promise<void> } | undefined
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
      WEDNESDAY_S3_ENDPOINT: `http://127.0.0.1:${provider.port}`,
      WEDNESDAY_S3_BUCKET: 'friday-test',
      WEDNESDAY_S3_ACCESS_KEY_ID: 'test-access-key',
      WEDNESDAY_S3_SECRET_ACCESS_KEY: 'test-secret-key',
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
      LoadOlder: '/api/chat/history',
      Send: '/api/chat/messages',
      Steer: '/api/chat/steering',
      Stop: '/api/chat/stop',
      ClearConversation: '/api/chat/clear',
      SaveSettings: '/api/settings',
      DiscoverModels: '/api/models',
      StartChatGpt: '/api/chatgpt/start',
      PollChatGpt: '/api/chatgpt/poll',
      CancelChatGpt: '/api/chatgpt/cancel',
      DisconnectChatGpt: '/api/chatgpt/disconnect',
    }[command._tag]
    const { _tag, ...payload } = command
    const read = _tag === 'Load' || _tag === 'LoadOlder'
    const query = command._tag === 'LoadOlder' ? `?beforeId=${command.beforeId}` : ''
    void fetch(`http://127.0.0.1:${applicationPort}${path}${query}`, {
      method: read ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token(this.userId, `http://localhost:${applicationPort}`)}`,
        'Content-Type': 'application/json',
        Origin: `http://localhost:${applicationPort}`,
      },
      body: read ? undefined : JSON.stringify(payload),
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
  expect(plainBody.length).toBeLessThan(3_200_000)
  const lazyChunk = /import\("(\.\/[^" ]+\.js)"\)/.exec(plainBody)?.[1]
  expect(lazyChunk).toBeDefined()
  if (!lazyChunk) throw new Error('Missing lazy frontend chunk')
  const chunk = await fetch(new URL(lazyChunk, new URL(script, origin)))
  expect(chunk.status).toBe(200)
  expect(chunk.headers.get('content-type')).toContain('javascript')
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
  if (path === '/codex/responses' || path === '/v1/responses') {
    const api = path === '/v1/responses'
    if (api) expect(request.headers.get('Authorization')).toBe('Bearer test-provider-secret')
    else {
      expect(request.headers.get('ChatGPT-Account-Id')).toBe('account-test')
      expect(request.headers.get('Authorization')).toBe(`Bearer ${chatGptAccessToken}`)
    }
    const raw = await request.text()
    const body = api ? parseResponsesRequest(raw) : parseCodexRequest(raw)
    if (api)
      formatRequests.push({
        format: 'responses',
        body: decodeObject(raw),
        sessionId: request.headers.get('Session-Id'),
      })
    else {
      codexRequests.push(body)
      expect(decodeObject(raw).prompt_cache_key).toBe(request.headers.get('Session-Id'))
      expect(request.headers.get('Session-Id')).toBe(
        isCompactionRequest(decodeObject(raw))
          ? 'user_device_complete:memory'
          : 'user_device_complete',
      )
    }
    const callsDate =
      body.tools?.some((tool) => tool.name === 'date') &&
      !/"(?:text|content)"\s*:\s*"Compaction:/.test(raw) &&
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
    if (!body.stream) return Response.json(response)
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
const anthropicProvider = async (request: Request) => {
  const url = new URL(request.url)
  if (url.pathname === '/anthropic/v1/models') {
    expect(request.headers.get('x-api-key')).toBe('test-provider-secret')
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01')
    return Response.json(
      url.searchParams.has('after_id')
        ? {
            data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet' }],
            has_more: false,
          }
        : {
            data: [{ id: 'claude-haiku-4-5', display_name: 'Claude Haiku' }],
            has_more: true,
            last_id: 'claude-haiku-4-5',
          },
    )
  }
  if (url.pathname === '/anthropic/v1/messages') {
    expect(request.headers.get('x-api-key')).toBe('test-provider-secret')
    const body = decodeObject(await request.text())
    formatRequests.push({ format: 'anthropic', body, sessionId: request.headers.get('Session-Id') })
    const messages = parseAnthropicMessages(body.messages)
    const callsDate =
      Array.isArray(body.tools) &&
      body.tools.length > 0 &&
      !messages.some((message) => message.content.some((part) => part.type === 'tool_result'))
    const content = callsDate
      ? [{ type: 'tool_use', id: 'anthropic-date', name: 'date', input: {} }]
      : [{ type: 'text', text: 'Hello from Anthropic' }]
    const result = {
      id: 'msg_anthropic',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: callsDate ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
      },
    }
    if (!body.stream) return Response.json(result)
    const events = [
      {
        type: 'message_start',
        message: {
          ...result,
          content: [],
          stop_reason: null,
          usage: { ...result.usage, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: callsDate ? { ...content[0], input: {} } : { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: callsDate
          ? { type: 'input_json_delta', partial_json: '{}' }
          : { type: 'text_delta', text: 'Hello from Anthropic' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: result.stop_reason, stop_sequence: null },
        usage: { ...result.usage, output_tokens: 10 },
      },
      { type: 'message_stop' },
    ]
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}
data: ${JSON.stringify(event)}

`,
        )
        .join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  return undefined
}
const completionProvider = async (request: Request) => {
  const url = new URL(request.url)
  if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'test-model' }] })
  const raw = await request.text()
  const body = parseRequest(raw)
  requests.push(parseJson(raw))
  const currentRequest = ++requestCount
  if (chatGate && body.model === 'test-model') await chatGate(body)
  if (streamingGate && body.model === 'test-model') {
    const gate = streamingGate
    streamingGate = undefined
    const encoder = new TextEncoder()
    const chunk = (content: string, done = false) =>
      encoder.encode(
        `data: ${JSON.stringify({ id: 'streamed_reply', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: done ? 'stop' : null }] })}\n\n`,
      )
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(chunk('First paragraph.\n\nUnfinished'))
          await gate.resume
          controller.enqueue(chunk(' paragraph.\n\n```ts\nconst x = 1\n```', true))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  const content =
    body.model === 'memory-model' && memoryResponse ? await memoryResponse(raw) : 'A saved reply.'
  if (body.model === 'memory-model') memoryRequests.push(raw)
  if (holdFirstResponse && currentRequest === 1) {
    firstRequestResolve?.()
    await firstResponse
  }
  const attachmentTool =
    raw.includes('attachment-bash-proof') && !raw.includes('call_attachment_bash')
  const tool = (holdFirstResponse && currentRequest === 1) || attachmentTool
  const delta = completionDelta(tool, attachmentTool, content)
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
}
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'wednesday-test-'))
  binary = join(temporary, 'wednesday')
  const build = Bun.spawn(['bun', 'scripts/build.ts', '--outfile', binary], {
    cwd: join(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await build.exited).toBe(0)
  applicationPort = port()
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const objectResponse = await objectRequest(request)
      if (objectResponse) return objectResponse
      if (request.headers.get('content-encoding') === 'zstd') {
        const body = zstdDecompressSync(Buffer.from(await request.arrayBuffer()))
        const headers = new Headers(request.headers)
        headers.delete('content-encoding')
        headers.delete('content-length')
        request = new globalThis.Request(request.url, { method: request.method, headers, body })
      }
      if (request.headers.get('upgrade') === 'websocket') return new Response(null, { status: 426 })
      const deviceResponse = await deviceProvider(request)
      if (deviceResponse) return deviceResponse
      const anthropicResponse = await anthropicProvider(request)
      if (anthropicResponse) return anthropicResponse
      return completionProvider(request)
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

test('embeds an installable Friday manifest and correctly sized app icons', async () => {
  const origin = `http://127.0.0.1:${applicationPort}`
  const html = await (await fetch(origin + '/settings')).text()
  const href = html.match(/rel="manifest" href="([^" ]+)"/)?.[1]
  if (!href) throw new Error('Missing install manifest')
  expect(html).toContain('name="theme-color" content="#ffffff"')
  expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"')
  const response = await fetch(new URL(href, origin))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/manifest+json')
  const manifest = parseManifest(await response.text())
  expect(manifest).toMatchObject({
    id: '/',
    name: 'Friday',
    short_name: 'Friday',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#ffffff',
  })
  expect(manifest.icons.map((icon) => [icon.sizes, icon.purpose])).toEqual([
    ['192x192', 'any'],
    ['512x512', 'any'],
    ['512x512', 'maskable'],
  ])
  for (const icon of manifest.icons) {
    const resource = await fetch(new URL(icon.src, origin))
    expect(resource.status).toBe(200)
    expect(resource.headers.get('content-type')).toContain('image/png')
    expect(resource.headers.get('cache-control')).toBe('no-cache')
    const bytes = Buffer.from(await resource.arrayBuffer())
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes)
  }
})

test('compiled binary embeds frontend and rejects cross-origin HTTP requests', async () => {
  const html = await fetch(`http://127.0.0.1:${applicationPort}/`).then((response) =>
    response.text(),
  )
  expect(html).toContain('<title>Friday</title>')
  const script = html.match(/src="([^"]+\.js)"/)
  expect(script?.[1]).toBeDefined()
  const asset = await fetch(
    new URL(script?.[1] ?? '', `http://127.0.0.1:${applicationPort}/`),
  ).then((response) => response.text())
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
  const stopped = await first.wait(
    (event) => event._tag === 'Discarded' && event.requestIds.includes('tabs-steer'),
  )
  expect(stopped._tag === 'Discarded' && stopped.reason).toBe('stopped')
  await third.wait((event) => event._tag === 'Status' && !event.busy)
  gate.release()
  expect((await first.snapshot()).pending).toEqual([])
  expect((await first.snapshot()).messages.some((item) => item.text === 'Correction')).toBe(false)
  first.close()
  second.close()
  third.close()
}, 10000)

test('native Pi steering continues after a response without tools and rejects steering for an ended turn', async () => {
  const client = await connect('user_discard')
  await save(client)
  const gate = holdChat()
  client.send({ _tag: 'Send', requestId: 'discard-turn', text: 'One complete response' })
  await gate.started
  client.send({
    _tag: 'Steer',
    requestId: 'discard-steer',
    text: 'A correction without a tool boundary',
    turnId: 'discard-turn',
  })
  await client.wait((event) => event._tag === 'Accepted' && event.requestId === 'discard-steer')
  const count = requestCount
  gate.release()
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  const history = await client.snapshot()
  expect(history.messages.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual([
    'One complete response',
    'A correction without a tool boundary',
  ])
  expect(requestCount).toBe(count + 1)
  expect(
    client.observed.some(
      (event) => event._tag === 'Discarded' && event.requestIds.includes('discard-steer'),
    ),
  ).toBe(false)
  expect(client.observed.every((event) => String(event._tag) !== 'Delta')).toBe(true)
  const lastId = history.messages.at(-1)?.id ?? -1
  client.close()
  const reconnect = await connect('user_discard', 0)
  expect(reconnect.initial?.messages.map((item) => item.id)).toEqual(
    history.messages.filter((item) => item.id > 0).map((item) => item.id),
  )
  expect(reconnect.initial?.messages.at(-1)?.id).toBe(lastId)
  expect(reconnect.initial?.messages.at(-1)?.text).toBe('A saved reply.')
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

test('defers new compactions during a chat turn and resumes them after Stop', async () => {
  const client = await connect('user_compaction_priority')
  await save(client, 'memory-model', 'low')
  let started = false
  let notifyStarted: (() => void) | undefined
  const memoryStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  memoryResponse = () => {
    started = true
    notifyStarted?.()
    return 'user: Preserve the original decision.'
  }
  const gate = holdChat()
  client.send({
    _tag: 'Send',
    requestId: 'priority-turn',
    text: 'Remember this decision. ' + 'q'.repeat(800),
  })
  await gate.started
  const snapshot = await client.snapshot()
  expect(snapshot.busy).toBe(true)
  expect(started).toBe(false)
  client.send({ _tag: 'Stop', turnId: 'priority-turn' })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  await memoryStarted
  expect(started).toBe(true)
  gate.release()
  memoryResponse = undefined
  client.close()
}, 10000)

test('compacts in the background with eight calls, bounded source context, and a separate model', async () => {
  const firstRequest = requests.length
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
  const observer = await connect('user_memory')
  const background = observer.initial
  client.send({ _tag: 'Send', requestId: 'after_compaction', text: 'What did I tell you?' })
  await observer.wait((event) => event._tag === 'MemoryStatus' && event.status === 'preparing')
  const preparing = await observer.snapshot()
  releaseResolve?.()
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  await observer.wait((event) => event._tag === 'MemoryStatus' && event.status === 'idle')
  expect(background?.memoryStatus).toBe('updating')
  expect(preparing.memoryStatus).toBe('preparing')
  observer.close()
  expect(peak).toBe(8)
  const sent = requests.slice(firstRequest)
  for (const [model, prompt] of [
    ['test-model', turnInstructions],
    ['memory-model', compactionInstructions],
  ]) {
    expect(sent).toContainEqual(
      expect.objectContaining({
        model,
        messages: expect.arrayContaining([expect.objectContaining({ content: prompt })]),
      }),
    )
  }
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
  let failedCount = failed.get()?.count ?? 0
  while (failedCount === 0 && Date.now() < deadline) {
    await Bun.sleep(10)
    failedCount = failed.get()?.count ?? 0
  }
  expect(failedCount).toBeGreaterThan(0)
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

test('starts chat from ready leaves when an unused ancestor fails compaction', async () => {
  const client = await connect('user_unused_ancestor')
  await save(client, 'memory-model')
  memoryResponse = (raw) =>
    raw.includes('Compaction: merge lines') ? '' : 'user: ' + 'q'.repeat(506)
  client.send({
    _tag: 'Send',
    requestId: 'ancestor-first',
    text: 'Remember this decision. ' + 'q'.repeat(800),
  })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  client.send({ _tag: 'Send', requestId: 'ancestor-next', text: 'Continue with the decision.' })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  const snapshot = await client.snapshot()
  expect(snapshot.messages.filter((message) => message.kind === 'talk')).toHaveLength(2)
  const database = new Database(join(temporary, 'test.sqlite'), { readonly: true })
  const failed = database.query<{ count: number }, []>(
    'SELECT count(*) AS count FROM wednesday_memory_jobs WHERE user_id="user_unused_ancestor" AND count>1 AND status="failed"',
  )
  const deadline = Date.now() + 3000
  let failedCount = failed.get()?.count ?? 0
  while (failedCount === 0 && Date.now() < deadline) {
    await Bun.sleep(10)
    failedCount = failed.get()?.count ?? 0
  }
  expect(failedCount).toBeGreaterThan(0)
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
    client.observed.some(
      (event) =>
        event._tag === 'Message' &&
        event.message.kind === 'tool' &&
        event.message.text.includes('date'),
    ),
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

test('pages 250 visible messages without overlap and isolates users', async () => {
  const database = new Database(join(temporary, 'test.sqlite'))
  const insert = database.prepare(
    'INSERT INTO wednesday_messages (user_id, id, kind, text, date) VALUES (?, ?, ?, ?, ?)',
  )
  database.transaction(() => {
    for (let index = 0; index < 501; index++) {
      insert.run(
        'user_pages',
        index * 2,
        index % 2 ? 'talk' : 'user',
        `Message ${index}`,
        '2026-10-13',
      )
      insert.run('user_pages', index * 2 + 1, 'tool', 'Hidden tool', '2026-10-13')
    }
    insert.run('user_other_pages', 0, 'user', 'Private message', '2026-10-13')
  })()
  database.close()
  const client = await connect('user_pages')
  const initial = client.initial
  expect(initial?.messages).toHaveLength(250)
  expect(initial?.messages[0]?.id).toBe(502)
  expect(initial?.messages.at(-1)?.id).toBe(1000)
  expect(initial?.hasOlder).toBe(true)
  client.send({ _tag: 'LoadOlder', beforeId: 502 })
  const older = await client.wait((event) => event._tag === 'History')
  expect(older._tag === 'History' && older.messages).toHaveLength(250)
  expect(older._tag === 'History' && older.messages[0]?.id).toBe(2)
  expect(older._tag === 'History' && older.messages.at(-1)?.id).toBe(500)
  client.send({ _tag: 'LoadOlder', beforeId: 2 })
  const oldest = await client.wait((event) => event._tag === 'History')
  expect(oldest._tag === 'History' && oldest.messages.map((message) => message.id)).toEqual([0])
  expect(oldest._tag === 'History' && oldest.hasOlder).toBe(false)
  const other = await connect('user_other_pages')
  expect(other.initial?.messages.map((message) => message.text)).toEqual(['Private message'])
  const resumed = await connect('user_pages', 1000)
  expect(resumed.initial?.hasOlder).toBeUndefined()
  expect(resumed.initial?.messages.every((message) => message.id > 1000)).toBe(true)
  client.close()
  other.close()
  resumed.close()
})

test('streams completed paragraphs, restores them for another tab, and replaces them with durable text', async () => {
  const client = await connect('user_paragraphs')
  await save(client)
  let release = () => {}
  const resume = new Promise<void>((resolve) => {
    release = resolve
  })
  streamingGate = { resume }
  client.send({ _tag: 'Send', requestId: 'paragraph_turn', text: 'Write paragraphs.' })
  const streamed = await client.wait((event) => event._tag === 'Streaming' && !!event.message)
  expect(streamed._tag === 'Streaming' && streamed.message?.text).toBe('First paragraph.')
  const other = await connect('user_paragraphs')
  expect(other.initial?.streaming?.text).toBe('First paragraph.')
  expect(other.initial?.messages.some((message) => message.kind === 'talk')).toBe(false)
  release()
  const completed = await client.wait(
    (event) => event._tag === 'Message' && event.message.kind === 'talk',
  )
  expect(completed._tag === 'Message' && completed.completesStreaming).toBe(true)
  expect(completed._tag === 'Message' && completed.message.text).toBe(
    'First paragraph.\n\nUnfinished paragraph.\n\n```ts\nconst x = 1\n```',
  )
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  expect((await client.snapshot()).streaming).toBeNull()
  await other.wait((event) => event._tag === 'Message' && event.message.kind === 'talk')
  client.close()
  other.close()
})

const expectInitialOptChatPrompt = (body: Record<string, Schema.Json> | undefined) => {
  const messages = body?.input ?? body?.messages
  if (!Array.isArray(messages)) throw new Error('Initial messages are missing')
  const users = messages.flatMap((message) => {
    const decoded = userMessage(message)
    return decoded._tag === 'Some' ? [decoded.value] : []
  })
  expect(users).toHaveLength(1)
  const content = users[0]?.content
  if (!Array.isArray(content)) throw new Error('Initial text blocks are missing')
  expect(content.map((part) => part.text)).toEqual([
    '<chat>\n',
    '</chat>\n',
    'What is the date? ' + 'context '.repeat(100),
  ])
}

for (const format of ['responses', 'anthropic'] as const) {
  test(`discovers and runs OptChat with ${format}, including memory requests`, async () => {
    const client = await connect(`user_format_${format}`)
    const baseUrl = `http://127.0.0.1:${provider.port}/${format === 'anthropic' ? 'anthropic/v1' : 'v1'}`
    client.send({
      _tag: 'DiscoverModels',
      baseUrl,
      apiKey: 'test-provider-secret',
      apiFormat: format,
    })
    const discovery = await client.wait(
      (event) => event._tag === 'Models' || event._tag === 'Error',
    )
    expect(discovery._tag).toBe('Models')
    if (discovery._tag !== 'Models') throw new Error('Discovery failed')
    if (format === 'anthropic') {
      expect(discovery.models.map((model) => model.displayName)).toEqual([
        'Claude Haiku',
        'Claude Sonnet',
      ])
      expect(discovery.models[1]?.thinking.low).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      })
    }
    const mapping = discovery.models.at(-1)
    if (!mapping) throw new Error('No model')
    client.send({
      _tag: 'SaveSettings',
      apiKey: 'test-provider-secret',
      settings: {
        provider: 'api',
        apiFormat: format,
        baseUrl,
        models: [mapping],
        modelId: mapping.id,
        thinking: format === 'anthropic' ? 'low' : 'off',
        memoryModelId: mapping.id,
        memoryThinking: 'off',
      },
    })
    expect(
      (await client.wait((event) => event._tag === 'Saved' || event._tag === 'Error'))._tag,
    ).toBe('Saved')
    const before = formatRequests.length
    client.send({
      _tag: 'Send',
      requestId: `format-${format}`,
      text: 'What is the date? ' + 'context '.repeat(100),
    })
    await client.wait((event) => event._tag === 'Status' && !event.busy)
    const snapshot = await client.snapshot()
    expect(client.observed.filter((event) => event._tag === 'Error')).toEqual([])
    expect(snapshot.messages.filter((message) => message.kind === 'talk').at(-1)?.text).toBe(
      format === 'anthropic' ? 'Hello from Anthropic' : 'Hello from ChatGPT',
    )
    client.send({ _tag: 'Send', requestId: `followup-${format}`, text: 'Continue.' })
    await client.wait((event) => event._tag === 'Status' && !event.busy)
    const sent = formatRequests.slice(before).filter((request) => request.format === format)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(sent[0]?.body).toMatchObject(
      format === 'anthropic'
        ? { max_tokens: 8192, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
        : { max_output_tokens: 8192, store: false },
    )
    expect(Array.isArray(sent[0]?.body.tools)).toBe(true)
    expectInitialOptChatPrompt(sent[0]?.body)
    for (const request of sent) {
      const identity = isCompactionRequest(request.body) ? `${client.userId}:memory` : client.userId
      expect(request.sessionId).toBe(identity)
      if (!isCompactionRequest(request.body))
        expect(request.body.tools).toEqual(sent[0]?.body.tools)
      else expect(JSON.stringify(request.body.tools)).not.toContain('private virtual filesystem')
      if (format === 'responses') expect(request.body.prompt_cache_key).toBe(identity)
    }
    expect(sent.some((request) => JSON.stringify(request.body).includes('Compaction:'))).toBe(true)
    if (format === 'anthropic') expect(sent[0]?.body.system).toBeDefined()
    client.close()
  }, 15000)
}

test('memory browsing reads stored summaries and originals with isolated, bounded ranges', async () => {
  const userId = 'user_memory_atlas_reader'
  const database = new Database(join(temporary, 'test.sqlite'))
  // The server may still be writing background summaries while this fixture is seeded.
  database.exec('PRAGMA busy_timeout = 5000')
  database
    .query('INSERT INTO wednesday_messages (user_id,id,kind,text,date) VALUES (?,?,?,?,?)')
    .run(userId, 0, 'user', 'Original wording', '2026-10-14T00:00:00.000Z')
  database
    .query('INSERT INTO wednesday_messages (user_id,id,kind,text,date) VALUES (?,?,?,?,?)')
    .run(userId, 1, 'talk', 'Friday response', '2026-10-14T00:01:00.000Z')
  database
    .query('INSERT INTO wednesday_memory_nodes (user_id,id,count,text) VALUES (?,?,?,?)')
    .run(userId, 0, 1, 'Saved summary')
  database.close()
  const read = (path: string, account = userId) =>
    fetch(`http://127.0.0.1:${applicationPort}${path}`, {
      headers: {
        Authorization: `Bearer ${token(account, `http://localhost:${applicationPort}`)}`,
        Origin: `http://localhost:${applicationPort}`,
      },
    })
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(MemorySnapshot))
  const response = await read('/api/memory?detail=0')
  expect(response.status).toBe(200)
  expect(decode(await response.text())).toEqual({
    total: 2,
    start: 0,
    end: 2,
    tiles: [
      { id: 0, count: 1, text: 'Saved summary' },
      { id: 1, count: 1, text: null },
    ],
  })
  const original = await read('/api/memory/original?id=0')
  expect(parseMemoryOriginal(await original.text())?.text).toBe('Original wording')
  const other = await read('/api/memory?detail=0', 'user_memory_atlas_other')
  expect(decode(await other.text())).toEqual({ total: 0, start: 0, end: 0, tiles: [] })
  expect(await (await read('/api/memory/original?id=0', 'user_memory_atlas_other')).text()).toBe(
    'null',
  )
  for (const query of [
    'detail=4',
    'detail=-1',
    'detail=0&start=2&end=1',
    'detail=0&end=999',
    'detail=0&start=-1',
  ])
    expect((await read(`/api/memory?${query}`)).status).toBe(400)
  expect((await fetch(`http://127.0.0.1:${applicationPort}/api/memory?detail=0`)).status).toBe(401)
})

test('replies carry canonical private context and survive history reloads', async () => {
  const client = await connect('user_replies')
  await save(client)
  client.send({ _tag: 'Send', requestId: 'reply-first', text: 'An original message to reply to.' })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  const first = await client.snapshot()
  const original = first.messages.find((message) => message.kind === 'talk')
  if (!original || original.kind !== 'talk') throw new Error('Missing response')
  const reply = { id: original.id, kind: original.kind, text: original.text }
  client.send({
    _tag: 'Send',
    requestId: 'reply-second',
    text: 'Explain that answer.',
    replyTo: original.id,
  })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  const history = await client.snapshot()
  expect(history.messages.find((message) => message.requestId === 'reply-second')).toMatchObject({
    text: 'Explain that answer.',
    reply,
  })
  expect(JSON.stringify(requests)).toContain(`> ${original.text}`)
  client.send({ _tag: 'LoadOlder', beforeId: Number.MAX_SAFE_INTEGER })
  const older = await client.wait((event) => event._tag === 'History')
  expect(
    older._tag === 'History' &&
      older.messages.find((message) => message.requestId === 'reply-second')?.reply,
  ).toEqual(reply)
  const other = await connect('user_reply_other')
  await save(other)
  other.send({
    _tag: 'Send',
    requestId: 'reply-private',
    text: 'Read their message',
    replyTo: original.id,
  })
  const rejected = await other.wait((event) => event._tag === 'Error')
  expect(rejected._tag).toBe('Error')
  expect((await other.snapshot()).messages).toEqual([])
  client.close()
  other.close()
}, 15000)

test('private attachments survive reload, images reach the model, and the compiled Bash tool reads files', async () => {
  const client = await connect('user_attachments')
  await save(client)
  const headers = {
    Authorization: `Bearer ${token(client.userId, `http://localhost:${applicationPort}`)}`,
    'Content-Type': 'application/json',
  }
  const url = `http://127.0.0.1:${applicationPort}/api/attachments`
  const upload = async (name: string, mediaType: string, data: string) => {
    const bytes = Buffer.from(data, 'base64')
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, mediaType, size: bytes.length }),
    })
    expect(response.status).toBe(200)
    const prepared = parsePreparedUpload(await response.text())
    expect(
      (
        await fetch(prepared.url, {
          method: 'PUT',
          headers: { 'Content-Type': prepared.attachment.mediaType },
          body: bytes,
        })
      ).ok,
    ).toBe(true)
    const complete = await fetch(`${url}/${prepared.attachment.id}/complete`, {
      method: 'POST',
      headers,
    })
    expect(complete.status).toBe(200)
    return parseAttachment(await complete.text())
  }
  const note = await upload(
    'note.md',
    'text/markdown',
    Buffer.from('# private attachment proof').toString('base64'),
  )
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII='
  const image = await upload('image.png', 'image/png', png)
  const first = requests.length
  client.send({
    _tag: 'Send',
    requestId: 'attachments-first',
    text: 'attachment-bash-proof: inspect these files',
    attachmentIds: [note.id, image.id],
  })
  await client.wait((event) => event._tag === 'Status' && !event.busy)
  const history = await client.snapshot()
  expect(
    history.messages.find((message) => message.requestId === 'attachments-first'),
  ).toMatchObject({
    text: 'attachment-bash-proof: inspect these files',
    attachments: [note, image],
  })
  expect(JSON.stringify(requests.slice(first))).toContain('image_url')
  expect(JSON.stringify(requests.slice(first))).toContain('data:image/')
  expect(JSON.stringify(requests.slice(first))).toContain('private attachment proof')
  expect(JSON.stringify(history)).not.toContain(png)
  const file = await fetch(`${url}/${note.id}`, { headers })
  const restored = parseAttachmentDownload(await file.text())
  expect(await (await fetch(restored.url)).text()).toBe('# private attachment proof')
  const other = await connect('user_attachments_other')
  await save(other)
  expect(
    (
      await fetch(`${url}/${note.id}`, {
        headers: {
          Authorization: `Bearer ${token(other.userId, `http://localhost:${applicationPort}`)}`,
        },
      })
    ).status,
  ).toBe(400)
  other.send({
    _tag: 'Send',
    requestId: 'stolen-attachment',
    text: 'Read it',
    attachmentIds: [note.id],
  })
  expect((await other.wait((event) => event._tag === 'Error'))._tag).toBe('Error')
  expect((await other.snapshot()).messages).toEqual([])
  client.send({ _tag: 'LoadOlder', beforeId: Number.MAX_SAFE_INTEGER })
  const older = await client.wait((event) => event._tag === 'History')
  expect(
    older._tag === 'History' &&
      older.messages.find((message) => message.requestId === 'attachments-first')?.attachments,
  ).toEqual([note, image])
  client.close()
  other.close()
}, 15000)

test('clears private chat and memory across tabs and reconnects while preserving settings', async () => {
  const userId = 'user_clear_conversation'
  const first = await connect(userId)
  await save(first)
  first.send({ _tag: 'Send', requestId: 'before-clear', text: 'Remember this before clearing.' })
  await first.wait((event) => event._tag === 'Status' && !event.busy)
  const before = await first.snapshot()
  expect(before.messages.length).toBeGreaterThan(0)
  const second = await connect(userId)
  const other = await connect('user_clear_other')
  await save(other)
  other.send({ _tag: 'Send', requestId: 'other-retained', text: 'Keep my conversation.' })
  await other.wait((event) => event._tag === 'Status' && !event.busy)
  const gate = holdChat()
  first.send({ _tag: 'Send', requestId: 'clear-busy', text: 'Wait while I respond.' })
  await gate.started
  first.send({ _tag: 'ClearConversation' })
  const rejected = await first.wait((event) => event._tag === 'Error')
  expect(rejected._tag === 'Error' && rejected.message).toContain('Stop the response')
  first.send({ _tag: 'Stop', turnId: 'clear-busy' })
  await first.wait((event) => event._tag === 'Status' && !event.busy)
  gate.release()
  first.send({ _tag: 'ClearConversation' })
  const cleared = await first.wait((event) => event._tag === 'Snapshot' && event.revision === 1)
  const mirrored = await second.wait((event) => event._tag === 'Snapshot' && event.revision === 1)
  for (const event of [cleared, mirrored]) {
    if (event._tag !== 'Snapshot') throw new Error('Expected cleared snapshot')
    expect(event.messages).toEqual([])
    expect(event.settings).toEqual(before.settings)
    expect(event.hasApiKey).toBe(true)
    expect(event.memoryStatus).toBe('idle')
  }
  const db = new Database(join(temporary, 'test.sqlite'), { readonly: true })
  for (const table of [
    'wednesday_messages',
    'wednesday_logs',
    'wednesday_memory_views',
    'wednesday_memory_nodes',
    'wednesday_memory_jobs',
  ]) {
    expect(
      db
        .query<{ count: number }, [string]>(
          `SELECT count(*) AS count FROM ${table} WHERE user_id=?`,
        )
        .get(userId)?.count,
    ).toBe(0)
  }
  db.close()
  expect((await other.snapshot()).messages.length).toBeGreaterThan(0)
  // Old cursors must receive the new conversation even after missing the reset event.
  first.send({ _tag: 'Send', requestId: 'before-clear', text: 'Start a fresh conversation.' })
  await first.wait((event) => event._tag === 'Status' && !event.busy)
  const reconnected = await connect(userId, 999)
  expect(reconnected.initial?.revision).toBe(1)
  expect(
    reconnected.initial?.messages.some((message) => message.text === 'Start a fresh conversation.'),
  ).toBe(true)
  expect(
    reconnected.initial?.messages.some(
      (message) => message.text === 'Remember this before clearing.',
    ),
  ).toBe(false)
  first.close()
  second.close()
  other.close()
  reconnected.close()
})
