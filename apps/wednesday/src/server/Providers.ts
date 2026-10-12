import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Config, Context, Effect, Layer, Redacted, Schema } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { OpenAiClient, OpenAiLanguageModel } from '@humanlayer/effect-ai-openai-compat'
import { customModel } from '@humanlayer/fold-core'
import { ModelMapping, type Settings, type Thinking } from '../shared/protocol.ts'
import { failure } from './errors.ts'

const protectedFields = new Set([
  'model',
  'messages',
  'input',
  'tools',
  'tool_choice',
  'stream',
  'stream_options',
])
export const validateMapping = (mapping: ModelMapping) =>
  Effect.gen(function* () {
    if (mapping.maxOutputTokens + 2048 >= mapping.contextWindow)
      return yield* failure(
        'Context window must leave at least 2048 tokens beyond the output limit.',
      )
    for (const fields of [mapping.requestFields, ...Object.values(mapping.thinking)]) {
      if (Object.keys(fields).some((key) => protectedFields.has(key)))
        return yield* failure(
          'Mappings cannot override model, messages, tools, or streaming fields.',
        )
    }
  })
export const normalizeBaseUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('Invalid URL')
      return url.toString().replace(/\/+$/, '')
    },
    catch: () =>
      failure('Enter an HTTP or HTTPS API base URL without credentials, query, or fragment.'),
  })

export const defaultMapping = (id: string) => {
  // /models has no standard capability metadata; these are editable starting points.
  const openaiReasoning = /^(o[134](?:-|$)|gpt-[56](?:[.-]|$))/.test(id)
  return {
    id,
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    requestFields: {},
    thinking: openaiReasoning
      ? {
          off: {},
          low: { reasoning_effort: 'low' },
          medium: { reasoning_effort: 'medium' },
          high: { reasoning_effort: 'high' },
        }
      : { off: {} },
  } satisfies ModelMapping
}

/** Encrypts provider keys before storage; the 32-byte key stays in runtime configuration. */
export class Credentials extends Context.Service<
  Credentials,
  {
    readonly encrypt: (key: string) => Effect.Effect<string, ReturnType<typeof failure>>
    readonly decrypt: (
      value: string,
    ) => Effect.Effect<Redacted.Redacted<string>, ReturnType<typeof failure>>
  }
>()('@wednesday/Credentials') {}
export const credentialsLayer = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    const configured = yield* Config.Redacted('WEDNESDAY_ENCRYPTION_KEY')
    const key = Buffer.from(Redacted.value(configured), 'base64')
    if (key.length !== 32)
      return yield* failure('WEDNESDAY_ENCRYPTION_KEY must be a base64-encoded 32-byte key.')
    const encrypt = Effect.fn('Credentials.encrypt')((value: string) =>
      Effect.try({
        try: () => {
          const iv = randomBytes(12)
          const cipher = createCipheriv('aes-256-gcm', key, iv)
          const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
          return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
        },
        catch: () => failure('Could not encrypt API key.'),
      }),
    )
    const decrypt = Effect.fn('Credentials.decrypt')((value: string) =>
      Effect.try({
        try: () => {
          const encoded = Buffer.from(value, 'base64')
          const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, 12))
          decipher.setAuthTag(encoded.subarray(12, 28))
          return Redacted.make(
            Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString(
              'utf8',
            ),
          )
        },
        catch: () => failure('Could not decrypt API key; check the encryption key.'),
      }),
    )
    return Credentials.of({ encrypt, decrypt })
  }),
)

export const discoverModels = Effect.fn('Providers.discoverModels')(
  function* (baseUrl: string, key: Redacted.Redacted<string>) {
    const url = yield* normalizeBaseUrl(baseUrl)
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(`${url}/models`).pipe(HttpClientRequest.bearerToken(key)),
    )
    const models = yield* HttpClientResponse.schemaBodyJson(
      Schema.Struct({
        data: Schema.Array(
          Schema.Struct({
            id: Schema.NonEmptyString,
            name: Schema.optionalKey(Schema.NullOr(Schema.String)),
            display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
            displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    )(yield* HttpClientResponse.filterStatusOk(response))
    return [...new Set(models.data.map((item) => item.id))].toSorted().map((id) => {
      const item = models.data.find((model) => model.id === id)
      const displayName =
        item?.display_name?.trim() || item?.displayName?.trim() || item?.name?.trim()
      const mapping = defaultMapping(id)
      return displayName ? { ...mapping, displayName } : mapping
    })
  },
  (effect) =>
    effect.pipe(
      Effect.timeout('30 seconds'),
      Effect.mapError(() => failure('Could not fetch models; check the API URL and key.')),
      Effect.provide(FetchHttpClient.layer),
    ),
)

export const configuredModel = (
  settings: Settings,
  key: Redacted.Redacted<string>,
  mapping: ModelMapping,
  thinking: Thinking,
) => {
  const fields = { ...mapping.requestFields, ...mapping.thinking[thinking] }
  const tokenField = /^(o[134](?:-|$)|gpt-[56](?:[.-]|$))/.test(mapping.id)
    ? 'max_completion_tokens'
    : 'max_tokens'
  const tokenFields =
    'max_tokens' in fields || 'max_completion_tokens' in fields
      ? {}
      : { [tokenField]: mapping.maxOutputTokens }
  return customModel({
    activeModel: {
      providerId: 'user-provider',
      providerKind: 'openai-compatible',
      modelId: mapping.id,
      role: null,
      requestedReasoningLevel: thinking,
      reasoning: { _tag: 'disabled' },
    },
    make: OpenAiLanguageModel.make({
      model: mapping.id,
      config: { ...tokenFields, ...fields, parallel_tool_calls: false, strictJsonSchema: false },
    }).pipe(
      Effect.provide(OpenAiClient.layer({ apiUrl: settings.baseUrl, apiKey: key })),
      Effect.provide(FetchHttpClient.layer),
    ),
  })
}
