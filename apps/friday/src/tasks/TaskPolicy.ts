/* oxlint-disable effecttsgo/node-builtin-import -- Workspace containment follows Node path semantics. */

import type { TaskStatus, TaskStatusFilter } from '@friday/contracts/conversation'
import { isAbsolute, relative, sep } from 'node:path'

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === 'pending' || status === 'running'
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'interrupted' || status === 'failed'
}

export const matchesTaskStatusFilter = (status: TaskStatus, filter: TaskStatusFilter): boolean => {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return isActiveTaskStatus(status)
    case 'terminal':
      return isTerminalTaskStatus(status)
  }
}

export function workingDirectoriesConflict(left: string, right: string): boolean {
  return left === right
}

export function isWorkingDirectoryInsideWorkspace(
  workspace: string,
  workingDirectory: string,
): boolean {
  const path = relative(workspace, workingDirectory)
  const [firstSegment] = path.split(sep)
  return firstSegment !== '..' && !isAbsolute(path)
}
