import { ModelSelection, SubagentProfileName } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

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

const primaryProfileName = Schema.decodeSync(SubagentProfileName)('primary')

export const makeTaskModels = (
  /** Reads the configured profiles on every resolution so reloads apply to new tasks. */
  configured: () => AppConfig['models']['subagents'],
): TaskModelsContract => {
  const find = (name: SubagentProfileName) => configured().find((profile) => profile.name === name)
  return TaskModels.of({
    defaultProfile: Effect.sync(() => Option.fromNullishOr(find(primaryProfileName))),
    resolve: (name) => Effect.sync(() => Option.fromNullishOr(find(name))),
  })
}

export const TaskModelsLive = (configured: () => AppConfig['models']['subagents']) =>
  Layer.succeed(TaskModels, makeTaskModels(configured))
