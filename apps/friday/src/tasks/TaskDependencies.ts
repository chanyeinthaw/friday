import type { IsoDateTime } from '@friday/contracts/conversation'
import type * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'

import type { FridayContract } from '../Friday.ts'
import type { ThreadPersistenceContract } from '../conversation/ThreadPersistence.ts'
import type {
  createIsolatedWorktree,
  RepositoryWorktreeError,
} from '../repositories/RepositoryWorktrees.ts'
import type { TaskError } from './TaskError.ts'
import type { TaskModelsContract } from './TaskModels.ts'

export interface MakeTasksOptions {
  readonly persistence: ThreadPersistenceContract
  readonly friday: FridayContract
  readonly models: TaskModelsContract
  readonly fileSystem: FileSystem.FileSystem
  readonly isManagedWorktree?: (path: string) => Effect.Effect<boolean, RepositoryWorktreeError>
  readonly createIsolatedWorktree?: typeof createIsolatedWorktree
  readonly randomUUID: Effect.Effect<string, TaskError>
  readonly now: Effect.Effect<IsoDateTime>
}
