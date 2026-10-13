import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Config, Context, Effect, Layer, Redacted, Schema } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { OpenAiClient, OpenAiLanguageModel } from '@humanlayer/effect-ai-openai-compat'
import {
  OpenAiClient as ResponsesClient,
  OpenAiLanguageModel as ResponsesModel,
} from '@effect/ai-openai'
import { AnthropicClient, AnthropicLanguageModel } from '@humanlayer/effect-ai-anthropic'
import { customModel } from '@humanlayer/fold-core'
import { ModelMapping, type Settings, type Thinking, type ApiFormat } from '../shared/protocol.ts'
import { failure } from './errors.ts'

const protectedFields = new Set([
  'model',
  'messages',
  'input',
  'system',
  'instructions',
  'previous_response_id',
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

const anthropicThinking = (id: string): ModelMapping['thinking'] => {
  if (/claude-(?:opus|sonnet)-4[.-][6-9]/.test(id))
    return {
      off: { thinking: { type: 'disabled' } },
      low: { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
      medium: { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } },
      high: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
    }
  if (/claude-(?:(?:opus|sonnet|haiku)-4|3[.-]7-sonnet)/.test(id))
    return {
      off: { thinking: { type: 'disabled' } },
      low: { thinking: { type: 'enabled', budget_tokens: 1024 } },
      medium: { thinking: { type: 'enabled', budget_tokens: 4096 } },
      high: { thinking: { type: 'enabled', budget_tokens: 6144 } },
    }
  return { off: {} }
}

// Anthropic's client owns /v1; users enter the same versioned base URL as other formats.
const anthropicRoot = (url: string) => url.replace(/\/v1\/?$/, '')

export const defaultMapping = (id: string, format: ApiFormat = 'chat-completions') => {
  // /models has no standard capability metadata; these are editable starting points.
  const openaiReasoning = /^(o[134](?:-|$)|gpt-[56](?:[.-]|$))/.test(id)
  return {
    id,
    contextWindow: format === 'anthropic' ? 200_000 : 128_000,
    maxOutputTokens: 8192,
    requestFields: {},
    thinking:
      format === 'anthropic'
        ? anthropicThinking(id)
        : openaiReasoning
          ? {
              off: {},
              low:
                format === 'responses'
                  ? { reasoning: { effort: 'low' } }
                  : { reasoning_effort: 'low' },
              medium:
                format === 'responses'
                  ? { reasoning: { effort: 'medium' } }
                  : { reasoning_effort: 'medium' },
              high:
                format === 'responses'
                  ? { reasoning: { effort: 'high' } }
                  : { reasoning_effort: 'high' },
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
  function* (
    baseUrl: string,
    key: Redacted.Redacted<string>,
    format: ApiFormat = 'chat-completions',
  ) {
    const url = yield* normalizeBaseUrl(baseUrl)
    const data: {
      id: string
      name?: string | null
      display_name?: string | null
      displayName?: string | null
    }[] = []
    let after: string | undefined
    const cursors = new Set<string>()
    do {
      const request = HttpClientRequest.get(
        format === 'anthropic' ? `${anthropicRoot(url)}/v1/models` : `${url}/models`,
      ).pipe(
        format === 'anthropic'
          ? HttpClientRequest.setHeaders({
              'x-api-key': Redacted.value(key),
              'anthropic-version': '2023-06-01',
            })
          : HttpClientRequest.bearerToken(key),
      )
      const response = yield* HttpClient.execute(
        after ? request.pipe(HttpClientRequest.setUrlParam('after_id', after)) : request,
      )
      const page = yield* HttpClientResponse.schemaBodyJson(
        Schema.Struct({
          data: Schema.Array(
            Schema.Struct({
              id: Schema.NonEmptyString,
              name: Schema.optionalKey(Schema.NullOr(Schema.String)),
              display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
              displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ),
          has_more: Schema.optionalKey(Schema.Boolean),
          last_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      )(yield* HttpClientResponse.filterStatusOk(response))
      data.push(...page.data)
      after = format === 'anthropic' && page.has_more ? (page.last_id ?? undefined) : undefined
      if (
        format === 'anthropic' &&
        page.has_more &&
        (!after || cursors.has(after) || cursors.size >= 100)
      )
        return yield* failure('The model list returned invalid pagination.')
      if (after) cursors.add(after)
    } while (after)

    return [...new Set(data.map((item) => item.id))].toSorted().map((id) => {
      const item = data.find((model) => model.id === id)
      const displayName =
        item?.display_name?.trim() || item?.displayName?.trim() || item?.name?.trim()
      const mapping = defaultMapping(id, format)
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
  const format = settings.apiFormat ?? 'chat-completions'
  const activeModel = {
    providerId: 'user-provider',
    providerKind: 'openai-compatible' as const,
    modelId: mapping.id,
    role: null,
    requestedReasoningLevel: thinking,
    reasoning: { _tag: 'disabled' as const },
  }
  if (format === 'responses')
    return customModel({
      activeModel,
      make: ResponsesModel.make({
        model: mapping.id,
        config: {
          max_output_tokens: mapping.maxOutputTokens,
          ...fields,
          store: false,
          useItemReferences: false,
          strictJsonSchema: false,
        },
      }).pipe(
        Effect.provide(ResponsesClient.layer({ apiUrl: settings.baseUrl, apiKey: key })),
        Effect.provide(FetchHttpClient.layer),
      ),
    })
  if (format === 'anthropic')
    return customModel({
      activeModel: {
        providerId: activeModel.providerId,
        providerKind: 'anthropic',
        modelId: mapping.id,
        role: null,
        requestedReasoningLevel: thinking,
        thinking: { _tag: 'disabled' },
      },
      make: AnthropicLanguageModel.make({
        model: mapping.id,
        config: {
          max_tokens: mapping.maxOutputTokens,
          ...fields,
          disableParallelToolCalls: true,
          strictJsonSchema: false,
        },
      }).pipe(
        Effect.provide(
          AnthropicClient.layer({ apiUrl: anthropicRoot(settings.baseUrl), apiKey: key }),
        ),
        Effect.provide(FetchHttpClient.layer),
      ),
    })
  const tokenField = /^(o[134](?:-|$)|gpt-[56](?:[.-]|$))/.test(mapping.id)
    ? 'max_completion_tokens'
    : 'max_tokens'
  const tokenFields =
    'max_tokens' in fields || 'max_completion_tokens' in fields
      ? {}
      : { [tokenField]: mapping.maxOutputTokens }
  return customModel({
    activeModel,
    make: OpenAiLanguageModel.make({
      model: mapping.id,
      config: { ...tokenFields, ...fields, parallel_tool_calls: false, strictJsonSchema: false },
    }).pipe(
      Effect.provide(OpenAiClient.layer({ apiUrl: settings.baseUrl, apiKey: key })),
      Effect.provide(FetchHttpClient.layer),
    ),
  })
}
