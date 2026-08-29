import type { ModelSelection } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import type { AppConfig } from '../config/AppConfig.ts'

export interface TaskModelsContract {
  readonly defaultModel: Effect.Effect<Option.Option<ModelSelection>>
  readonly resolve: (selection: ModelSelection) => Effect.Effect<Option.Option<ModelSelection>>
}

export class TaskModels extends Context.Service<TaskModels, TaskModelsContract>()(
  'friday/tasks/TaskModels',
) {}

const isSameModel = (left: ModelSelection, right: ModelSelection): boolean =>
  left.provider === right.provider && left.modelId === right.modelId

export const makeTaskModels = (configured: AppConfig['models']['subagents']): TaskModelsContract =>
  TaskModels.of({
    defaultModel: Effect.succeed(Option.fromNullishOr(configured[0])),
    resolve: (selection) =>
      Effect.succeed(
        Option.fromNullishOr(configured.find((model) => isSameModel(model, selection))),
      ),
  })

export const TaskModelsLive = (configured: AppConfig['models']['subagents']) =>
  Layer.succeed(TaskModels, makeTaskModels(configured))
