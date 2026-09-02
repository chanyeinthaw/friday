/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQLite rows are decoded immediately through Effect Schema. */

import {
  ModelId,
  ModelSelection,
  ProviderId,
  SubagentProfileName,
  ThinkingLevel,
} from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../persistence/Migrations.ts'

export const FixedModelName = Schema.Literals(['primary', 'utility'])
export type FixedModelName = typeof FixedModelName.Type

export const ConfiguredModelSelection = Schema.Struct({
  name: FixedModelName,
  ...ModelSelection.fields,
  thinkingLevel: ThinkingLevel,
})
export type ConfiguredModelSelection = typeof ConfiguredModelSelection.Type

export const StoredSubagentProfile = Schema.Struct({
  name: SubagentProfileName,
  description: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  ...ModelSelection.fields,
  thinkingLevel: ThinkingLevel,
})
export type StoredSubagentProfile = typeof StoredSubagentProfile.Type

export interface SubagentProfileInput {
  readonly name: SubagentProfileName
  readonly description: string
  readonly provider: ProviderId
  readonly modelId: ModelId
  readonly thinkingLevel: ThinkingLevel
}

export interface SubagentProfilePatch {
  readonly name: SubagentProfileName
  readonly description?: string
  readonly provider?: ProviderId
  readonly modelId?: ModelId
  readonly thinkingLevel?: ThinkingLevel
}

export type FixedModelSetOutcome = 'updated' | 'unchanged'
export type SubagentProfileAddOutcome = 'added' | 'exists'
export type SubagentProfileUpdateOutcome = 'updated' | 'unchanged' | 'missing'
export type SubagentProfileRemoveOutcome = 'removed' | 'missing' | 'protected'

export class ModelConfigurationError extends Schema.Error<ModelConfigurationError>(
  'ModelConfigurationError',
)({
  _tag: Schema.tag('ModelConfigurationError'),
  operation: Schema.Literals([
    'list-models',
    'get-model',
    'set-model',
    'list-profiles',
    'get-profile',
    'add-profile',
    'update-profile',
    'remove-profile',
    'migrate',
    'decode',
  ]),
  subject: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const summary =
      this.subject === undefined
        ? `Model configuration ${this.operation} failed.`
        : `Model configuration ${this.operation} failed for ${this.subject}.`
    return this.detail === undefined ? summary : `${summary} ${this.detail}`
  }
}

export interface ModelConfigurationContract {
  readonly listModels: () => Effect.Effect<
    ReadonlyArray<ConfiguredModelSelection>,
    ModelConfigurationError
  >
  readonly getModel: (
    name: FixedModelName,
  ) => Effect.Effect<ConfiguredModelSelection, ModelConfigurationError>
  readonly setModel: (
    selection: ConfiguredModelSelection,
  ) => Effect.Effect<FixedModelSetOutcome, ModelConfigurationError>
  readonly listProfiles: () => Effect.Effect<
    ReadonlyArray<StoredSubagentProfile>,
    ModelConfigurationError
  >
  readonly getProfile: (
    name: SubagentProfileName,
  ) => Effect.Effect<Option.Option<StoredSubagentProfile>, ModelConfigurationError>
  readonly addProfile: (
    input: SubagentProfileInput,
  ) => Effect.Effect<SubagentProfileAddOutcome, ModelConfigurationError>
  readonly updateProfile: (
    patch: SubagentProfilePatch,
  ) => Effect.Effect<SubagentProfileUpdateOutcome, ModelConfigurationError>
  readonly removeProfile: (
    name: SubagentProfileName,
  ) => Effect.Effect<SubagentProfileRemoveOutcome, ModelConfigurationError>
}

export class ModelConfiguration extends Context.Service<
  ModelConfiguration,
  ModelConfigurationContract
>()('friday/config/ModelConfiguration') {}

const AgentModelRow = Schema.Struct({
  primary_provider: Schema.String,
  primary_model_id: Schema.String,
  primary_thinking_level: Schema.String,
  utility_provider: Schema.String,
  utility_model_id: Schema.String,
  utility_thinking_level: Schema.String,
})
const ProfileRow = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  provider: Schema.String,
  model_id: Schema.String,
  thinking_level: Schema.String,
})
const decodeAgentRows = Schema.decodeUnknownEffect(Schema.Array(AgentModelRow))
const decodeProfileRows = Schema.decodeUnknownEffect(Schema.Array(ProfileRow))
const decodeModels = Schema.decodeUnknownEffect(Schema.Array(ConfiguredModelSelection))
const decodeProfiles = Schema.decodeUnknownEffect(Schema.Array(StoredSubagentProfile))

export const ModelConfigurationLive = Layer.effect(
  ModelConfiguration,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const error =
      (operation: ModelConfigurationError['operation'], subject?: string) => (cause: unknown) =>
        new ModelConfigurationError({
          operation,
          subject,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        })

    yield* runMigrations().pipe(Effect.mapError(error('migrate')))

    const listModels = Effect.fn('ModelConfiguration.listModels')(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT primary_provider, primary_model_id, primary_thinking_level,
          utility_provider, utility_model_id, utility_thinking_level
        FROM agent_config WHERE id = 1
      `.pipe(Effect.mapError(error('list-models')))
      const decoded = yield* decodeAgentRows(rows).pipe(Effect.mapError(error('decode')))
      const row = decoded[0]
      if (row === undefined)
        return yield* error('list-models')(new Error('agent_config row is missing'))
      return yield* decodeModels([
        {
          name: 'primary',
          provider: row.primary_provider,
          modelId: row.primary_model_id,
          thinkingLevel: row.primary_thinking_level,
        },
        {
          name: 'utility',
          provider: row.utility_provider,
          modelId: row.utility_model_id,
          thinkingLevel: row.utility_thinking_level,
        },
      ]).pipe(Effect.mapError(error('decode')))
    })

    const listProfiles = Effect.fn('ModelConfiguration.listProfiles')(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT name, description, provider, model_id, thinking_level
        FROM subagent_profiles ORDER BY name
      `.pipe(Effect.mapError(error('list-profiles')))
      const decoded = yield* decodeProfileRows(rows).pipe(Effect.mapError(error('decode')))
      return yield* decodeProfiles(
        decoded.map((row) => ({
          name: row.name,
          description: row.description,
          provider: row.provider,
          modelId: row.model_id,
          thinkingLevel: row.thinking_level,
        })),
      ).pipe(Effect.mapError(error('decode')))
    })

    return ModelConfiguration.of({
      listModels,
      getModel: (name) =>
        listModels().pipe(
          Effect.flatMap((models) => {
            const model = models.find((candidate) => candidate.name === name)
            return model === undefined
              ? Effect.fail(new ModelConfigurationError({ operation: 'get-model', subject: name }))
              : Effect.succeed(model)
          }),
        ),
      setModel: (selection) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const current = yield* listModels()
              const existing = current.find((model) => model.name === selection.name)
              if (
                existing?.provider === selection.provider &&
                existing.modelId === selection.modelId &&
                existing.thinkingLevel === selection.thinkingLevel
              )
                return 'unchanged' as const
              if (selection.name === 'primary') {
                yield* sql`UPDATE agent_config SET primary_provider = ${selection.provider}, primary_model_id = ${selection.modelId}, primary_thinking_level = ${selection.thinkingLevel}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
              } else {
                yield* sql`UPDATE agent_config SET utility_provider = ${selection.provider}, utility_model_id = ${selection.modelId}, utility_thinking_level = ${selection.thinkingLevel}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
              }
              return 'updated' as const
            }),
          )
          .pipe(Effect.mapError(error('set-model', selection.name))),
      listProfiles,
      getProfile: (name) =>
        listProfiles().pipe(
          Effect.map((profiles) =>
            Option.fromNullishOr(profiles.find((profile) => profile.name === name)),
          ),
        ),
      addProfile: (input) =>
        sql<Record<string, unknown>>`
        INSERT INTO subagent_profiles (name, description, provider, model_id, thinking_level, updated_at)
        VALUES (${input.name}, ${input.description}, ${input.provider}, ${input.modelId}, ${input.thinkingLevel}, CURRENT_TIMESTAMP)
        ON CONFLICT (name) DO NOTHING RETURNING name
      `.pipe(
          Effect.map((rows): SubagentProfileAddOutcome =>
            rows[0] === undefined ? 'exists' : 'added',
          ),
          Effect.mapError(error('add-profile', input.name)),
        ),
      updateProfile: (patch) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const profiles = yield* listProfiles()
              const current = profiles.find((profile) => profile.name === patch.name)
              if (current === undefined) return 'missing' as const
              const next = {
                description: patch.description ?? current.description,
                provider: patch.provider ?? current.provider,
                modelId: patch.modelId ?? current.modelId,
                thinkingLevel: patch.thinkingLevel ?? current.thinkingLevel,
              }
              if (
                next.description === current.description &&
                next.provider === current.provider &&
                next.modelId === current.modelId &&
                next.thinkingLevel === current.thinkingLevel
              )
                return 'unchanged' as const
              yield* sql`UPDATE subagent_profiles SET description = ${next.description}, provider = ${next.provider}, model_id = ${next.modelId}, thinking_level = ${next.thinkingLevel}, updated_at = CURRENT_TIMESTAMP WHERE name = ${patch.name}`
              return 'updated' as const
            }),
          )
          .pipe(Effect.mapError(error('update-profile', patch.name))),
      removeProfile: (name) =>
        name === 'primary'
          ? Effect.succeed('protected')
          : sql<
              Record<string, unknown>
            >`DELETE FROM subagent_profiles WHERE name = ${name} RETURNING name`.pipe(
              Effect.map((rows): SubagentProfileRemoveOutcome =>
                rows[0] === undefined ? 'missing' : 'removed',
              ),
              Effect.mapError(error('remove-profile', name)),
            ),
    })
  }),
)
