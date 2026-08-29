import type { ModelSelection, SubagentProfileName } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import type { AppConfig, SubagentProfile } from '../config/AppConfig.ts'

export interface ResolvedTaskProfile {
  readonly name: SubagentProfileName
  readonly description: string
  readonly model: ModelSelection
  readonly thinkingLevel: SubagentProfile['thinkingLevel']
}

export interface TaskModelsContract {
  readonly defaultProfile: Effect.Effect<Option.Option<ResolvedTaskProfile>>
  readonly resolve: (name: SubagentProfileName) => Effect.Effect<Option.Option<ResolvedTaskProfile>>
}

export class TaskModels extends Context.Service<TaskModels, TaskModelsContract>()(
  'friday/tasks/TaskModels',
) {}

const resolvedProfile = (profile: SubagentProfile): ResolvedTaskProfile => profile

export const makeTaskModels = (
  configured: AppConfig['models']['subagents'],
): TaskModelsContract => {
  const profiles = configured.map(resolvedProfile)
  return TaskModels.of({
    defaultProfile: Effect.succeed(
      Option.fromNullishOr(profiles.find(({ name }) => name === 'primary')),
    ),
    resolve: (name) =>
      Effect.succeed(Option.fromNullishOr(profiles.find((profile) => profile.name === name))),
  })
}

export const TaskModelsLive = (configured: AppConfig['models']['subagents']) =>
  Layer.succeed(TaskModels, makeTaskModels(configured))
