import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  PartitionedSemaphore,
  Redacted,
  Schema,
  Schedule,
  Stream,
} from 'effect'
import { AiError } from 'effect/ai'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { OpenAiClient, OpenAiLanguageModel, OpenAiSchema } from '@effect/ai-openai'
import { customModel, type FoldModel } from '@humanlayer/fold-core'
import { DeviceAuthorization, ModelMapping, Thinking } from '../shared/protocol.ts'
import { Credentials } from './Providers.ts'
import { Storage } from './Storage.ts'
import { failure, type WednesdayError } from './errors.ts'

const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
const Tokens = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  accountId: Schema.NonEmptyString,
})
type Tokens = typeof Tokens.Type
const tokensCodec = Schema.fromJsonString(Tokens)
const TokenReply = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.Number,
})
const claimsCodec = Schema.fromJsonString(
  Schema.Struct({
    'https://api.openai.com/auth': Schema.optionalKey(
      Schema.Struct({ chatgpt_account_id: Schema.optionalKey(Schema.String) }),
    ),
  }),
)
const CodeReply = Schema.Struct({
  device_auth_id: Schema.NonEmptyString,
  user_code: Schema.optionalKey(Schema.String),
  usercode: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Union([Schema.Number, Schema.NumberFromString])),
})
const Approval = Schema.Struct({
  authorization_code: Schema.NonEmptyString,
  code_verifier: Schema.NonEmptyString,
})
const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      visibility: Schema.optionalKey(Schema.String),
      supported_in_api: Schema.optionalKey(Schema.Boolean),
      display_name: Schema.optionalKey(Schema.String),
      context_window: Schema.optionalKey(Schema.Number),
      supported_reasoning_levels: Schema.optionalKey(
        Schema.Array(Schema.Struct({ effort: Schema.String })),
      ),
    }),
  ),
})
const decodeThinking = Schema.decodeUnknownOption(Thinking)
const isString = Schema.is(Schema.String)
const SystemMessage = Schema.Struct({
  role: Schema.Literals(['system', 'developer']),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.String }))]),
})
const decodeSystemMessage = Schema.decodeUnknownOption(SystemMessage)
const decodeTerminalResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ response: OpenAiSchema.Response }),
)
const aiFailure = (message: string) =>
  AiError.make({
    module: 'ChatGpt',
    method: 'response',
    reason: new AiError.UnknownError({ description: message }),
  })

export class ChatGpt extends Context.Service<
  ChatGpt,
  {
    readonly begin: (userId: string) => Effect.Effect<DeviceAuthorization, WednesdayError>
    readonly poll: (
      userId: string,
      attemptId: string,
    ) => Effect.Effect<
      { encryptedKey: string; models: readonly ModelMapping[] } | null,
      WednesdayError
    >
    readonly cancel: (userId: string, attemptId?: string) => Effect.Effect<void>
    readonly access: (userId: string) => Effect.Effect<Tokens, WednesdayError>
    readonly models: (userId: string) => Effect.Effect<readonly ModelMapping[], WednesdayError>
    readonly model: (userId: string, mapping: ModelMapping, thinking: Thinking) => FoldModel
  }
>()('@wednesday/ChatGpt') {}

export const chatGptLayer = Layer.effect(
  ChatGpt,
  Effect.gen(function* () {
    const storage = yield* Storage
    const credentials = yield* Credentials
    const http = yield* HttpClient.HttpClient
    const issuer = yield* Config.String('WEDNESDAY_CHATGPT_ISSUER').pipe(
      Config.withDefault('https://auth.openai.com'),
    )
    const backend = yield* Config.String('WEDNESDAY_CHATGPT_BACKEND').pipe(
      Config.withDefault('https://chatgpt.com/backend-api/codex'),
    )
    const clientVersion = yield* Config.String('WEDNESDAY_CHATGPT_CLIENT_VERSION').pipe(
      Config.withDefault('0.160.0'),
    )
    const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 })
    type Attempt = {
      public: DeviceAuthorization
      deviceId: string
      nextPollAt: number
      tokens?: Tokens
    }
    const attempts = new Map<string, Attempt>()
    yield* Effect.sync(() => {
      for (const [userId, attempt] of attempts) {
        if (attempt.public.expiresAt <= Date.now()) attempts.delete(userId)
      }
    }).pipe(Effect.repeat(Schedule.spaced('1 minute')), Effect.forkScoped)
    const request = Effect.fn('ChatGpt.request')(function* (
      url: string,
      body: Record<string, string>,
    ) {
      return yield* HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyJson(body),
        Effect.flatMap(http.execute),
        Effect.timeout('20 seconds'),
        Effect.mapError(() => failure('ChatGPT could not be reached. Please try again.')),
      )
    })
    const decodeTokens = Effect.fn('ChatGpt.decodeTokens')(function* (
      response: HttpClientResponse.HttpClientResponse,
      previous?: Tokens,
    ) {
      const reply = yield* HttpClientResponse.schemaBodyJson(TokenReply)(response).pipe(
        Effect.mapError(() => failure('ChatGPT returned an invalid sign-in response.')),
      )
      const payload = (reply.id_token ?? reply.access_token).split('.')[1]
      const claims = payload
        ? Schema.decodeUnknownOption(claimsCodec)(Buffer.from(payload, 'base64url').toString())
        : Option.none()
      const accountId = Option.isSome(claims)
        ? claims.value['https://api.openai.com/auth']?.chatgpt_account_id
        : undefined
      const refreshToken = reply.refresh_token || previous?.refreshToken
      if (!(accountId || previous?.accountId) || !refreshToken)
        return yield* failure('ChatGPT did not return an account and refresh token.')
      return {
        accessToken: reply.access_token,
        refreshToken,
        accountId: accountId || previous?.accountId || '',
        expiresAt: Date.now() + reply.expires_in * 1000,
      }
    })
    const access = Effect.fn('ChatGpt.access')((userId: string) =>
      locks.withPermit(userId)(
        Effect.gen(function* () {
          const saved = yield* storage.settings(userId)
          if (saved?.settings.provider !== 'chatgpt' || !saved.encryptedKey)
            return yield* failure('Sign in with ChatGPT in Settings.')
          const current = yield* Schema.decodeUnknownEffect(tokensCodec)(
            Redacted.value(yield* credentials.decrypt(saved.encryptedKey)),
          ).pipe(Effect.mapError(() => failure('Sign in with ChatGPT again.')))
          if (current.expiresAt > Date.now() + 60_000) return current
          const response = yield* request(`${issuer}/oauth/token`, {
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken,
            client_id: clientId,
          })
          if (response.status < 200 || response.status >= 300)
            return yield* failure('Your ChatGPT sign-in expired. Sign in again in Settings.')
          const tokens = yield* decodeTokens(response, current)
          const latest = yield* storage.settings(userId)
          if (latest?.encryptedKey !== saved.encryptedKey)
            return yield* failure('Your provider settings changed. Please try again.')
          const encryptedKey = yield* credentials.encrypt(
            yield* Schema.encodeEffect(tokensCodec)(tokens).pipe(
              Effect.mapError(() => failure('Could not save ChatGPT credentials.')),
            ),
          )
          yield* storage.saveSettings(userId, { settings: latest.settings, encryptedKey })
          return tokens
        }),
      ),
    )
    const catalog = Effect.fn('ChatGpt.catalog')(
      function* (tokens: Tokens) {
        const response = yield* http.execute(
          HttpClientRequest.get(
            `${backend}/models?client_version=${encodeURIComponent(clientVersion)}`,
          ).pipe(
            HttpClientRequest.bearerToken(Redacted.make(tokens.accessToken)),
            HttpClientRequest.setHeader('ChatGPT-Account-Id', tokens.accountId),
            HttpClientRequest.setHeader('originator', 'codex_cli_rs'),
          ),
        )
        const result = yield* HttpClientResponse.schemaBodyJson(Catalog)(
          yield* HttpClientResponse.filterStatusOk(response),
        )
        const visible = result.models.filter(
          (item) => item.visibility !== 'hide' && item.supported_in_api !== false,
        )
        const mappings = visible.map((item) => {
          const thinking: ModelMapping['thinking'] = { off: {} }
          const levels = Object.fromEntries(
            (item.supported_reasoning_levels ?? []).flatMap(({ effort }) => {
              const parsed = decodeThinking(effort === 'none' ? 'off' : effort)
              return Option.isSome(parsed) ? [[parsed.value, { reasoning: { effort } }]] : []
            }),
          )
          return {
            id: item.slug,
            displayName: item.display_name || item.slug,
            contextWindow: item.context_window || 128000,
            maxOutputTokens: 8192,
            requestFields: {},
            thinking: { ...thinking, ...levels },
          } satisfies ModelMapping
        })
        if (!mappings.length)
          return yield* failure('No ChatGPT models are available for this account.')
        return mappings
      },
      (effect) =>
        effect.pipe(
          Effect.timeout('20 seconds'),
          Effect.mapError(() => failure('Could not load ChatGPT models. Please try again.')),
        ),
    )
    const begin = Effect.fn('ChatGpt.begin')(function* (userId: string) {
      attempts.delete(userId)
      const response = yield* request(`${issuer}/api/accounts/deviceauth/usercode`, {
        client_id: clientId,
      })
      if (response.status < 200 || response.status >= 300)
        return yield* failure(
          'Device-code sign-in is unavailable. Enable it in your ChatGPT security settings and try again.',
        )
      const reply = yield* HttpClientResponse.schemaBodyJson(CodeReply)(response).pipe(
        Effect.mapError(() => failure('ChatGPT returned an invalid device code.')),
      )
      const userCode = reply.user_code || reply.usercode
      if (!userCode) return yield* failure('ChatGPT did not return a device code.')
      const authorization = {
        attemptId: crypto.randomUUID(),
        userCode,
        verificationUrl: `${issuer}/codex/device`,
        expiresAt: Date.now() + 15 * 60_000,
        intervalSeconds: Math.max(1, reply.interval || 5),
      }
      attempts.set(userId, { public: authorization, deviceId: reply.device_auth_id, nextPollAt: 0 })
      return authorization
    })
    const cancel = (userId: string, attemptId?: string) =>
      Effect.sync(() => {
        if (!attemptId || attempts.get(userId)?.public.attemptId === attemptId)
          attempts.delete(userId)
      })
    const poll = Effect.fn('ChatGpt.poll')((userId: string, attemptId: string) =>
      locks.withPermit(userId)(
        Effect.gen(function* () {
          const attempt = attempts.get(userId)
          if (!attempt || attempt.public.attemptId !== attemptId)
            return yield* failure('This sign-in has ended. Get a new code.')
          if (Date.now() >= attempt.public.expiresAt) {
            attempts.delete(userId)
            return yield* failure('This code expired. Get a new code.')
          }
          if (!attempt.tokens) {
            if (Date.now() < attempt.nextPollAt) return null
            attempt.nextPollAt = Date.now() + attempt.public.intervalSeconds * 1000
            const response = yield* request(`${issuer}/api/accounts/deviceauth/token`, {
              device_auth_id: attempt.deviceId,
              user_code: attempt.public.userCode,
            })
            if (response.status === 403 || response.status === 404) return null
            if (response.status === 429) {
              attempt.nextPollAt += 5000
              return null
            }
            if (response.status < 200 || response.status >= 300)
              return yield* failure('ChatGPT sign-in was declined. Get a new code to try again.')
            const approval = yield* HttpClientResponse.schemaBodyJson(Approval)(response).pipe(
              Effect.mapError(() => failure('ChatGPT returned an invalid approval.')),
            )
            if (attempts.get(userId) !== attempt)
              return yield* failure('This sign-in was cancelled.')
            const exchange = yield* request(`${issuer}/oauth/token`, {
              grant_type: 'authorization_code',
              client_id: clientId,
              code: approval.authorization_code,
              code_verifier: approval.code_verifier,
              redirect_uri: `${issuer}/deviceauth/callback`,
            })
            if (exchange.status < 200 || exchange.status >= 300)
              return yield* failure('ChatGPT could not complete sign-in. Get a new code.')
            attempt.tokens = yield* decodeTokens(exchange)
          }
          const models = yield* catalog(attempt.tokens)
          if (attempts.get(userId) !== attempt) return yield* failure('This sign-in was cancelled.')
          return {
            models,
            encryptedKey: yield* credentials.encrypt(
              yield* Schema.encodeEffect(tokensCodec)(attempt.tokens).pipe(
                Effect.mapError(() => failure('Could not save ChatGPT credentials.')),
              ),
            ),
          }
        }),
      ),
    )
    const model = (userId: string, mapping: ModelMapping, thinking: Thinking) =>
      customModel({
        activeModel: {
          providerId: 'chatgpt',
          providerKind: 'codex',
          modelId: mapping.id,
          role: null,
          requestedReasoningLevel: thinking,
          reasoning: { _tag: 'disabled' },
        },
        make: Effect.gen(function* () {
          const client = yield* OpenAiClient.make({ apiUrl: backend })
          const authenticated = Effect.gen(function* () {
            const tokens = yield* access(userId)
            return yield* OpenAiClient.make({
              apiUrl: backend,
              apiKey: Redacted.make(tokens.accessToken),
              transformClient: (client) =>
                HttpClient.mapRequest(client, (request) =>
                  request.pipe(
                    HttpClientRequest.setHeader('ChatGPT-Account-Id', tokens.accountId),
                    HttpClientRequest.setHeader('originator', 'codex_cli_rs'),
                  ),
                ),
            }).pipe(Effect.provideService(HttpClient.HttpClient, http))
          }).pipe(Effect.mapError((error) => aiFailure(error.message)))
          const createResponseStream = Effect.fn('ChatGpt.responseStream')(function* (
            options: Parameters<OpenAiClient.Service['createResponseStream']>[0],
          ) {
            const auth = yield* authenticated
            const { max_output_tokens: _limit, previous_response_id: _previous, ...body } = options
            const input = Array.isArray(body.input) ? body.input : []
            const instructions = input.flatMap((item) => {
              const message = decodeSystemMessage(item)
              return Option.isSome(message)
                ? [
                    isString(message.value.content)
                      ? message.value.content
                      : message.value.content.map((part) => part.text).join('\n'),
                  ]
                : []
            })
            return yield* auth.createResponseStream({
              ...body,
              input: isString(body.input)
                ? body.input
                : input.filter((item) => Option.isNone(decodeSystemMessage(item))),
              instructions:
                [body.instructions, ...instructions].filter(Boolean).join('\n') ||
                'You are a helpful assistant.',
              store: false,
            })
          })
          const adapted = OpenAiClient.OpenAiClient.of({
            ...client,
            createResponseStream,
            createResponse: (options) =>
              Effect.gen(function* () {
                const { stream: _stream, ...body } = options
                const [response, events] = yield* createResponseStream(body)
                const completed = yield* events.pipe(
                  Stream.filter(
                    (event) =>
                      event.type === 'response.completed' ||
                      event.type === 'response.incomplete' ||
                      event.type === 'response.failed',
                  ),
                  Stream.take(1),
                  Stream.runLast,
                )
                if (Option.isNone(completed) || completed.value.type === 'response.failed')
                  return yield* aiFailure('ChatGPT did not complete its response.')
                const terminal = yield* decodeTerminalResponse(completed.value).pipe(
                  Effect.mapError(() => aiFailure('ChatGPT returned an invalid response.')),
                )
                return [terminal.response, response] as const
              }),
          })
          return yield* OpenAiLanguageModel.make({
            model: mapping.id,
            config: {
              ...mapping.requestFields,
              ...mapping.thinking[thinking],
              store: false,
              include: ['reasoning.encrypted_content'],
              useItemReferences: false,
              strictJsonSchema: false,
            },
          }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, adapted))
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      })
    return ChatGpt.of({
      begin,
      poll,
      cancel,
      access,
      models: (userId) => access(userId).pipe(Effect.flatMap(catalog)),
      model,
    })
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
