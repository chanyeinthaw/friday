import { describe, expect, it } from 'vitest'

import {
  isActiveTaskStatus,
  isTerminalTaskStatus,
  isWorkingDirectoryInsideWorkspace,
  matchesTaskStatusFilter,
  workingDirectoriesConflict,
} from './TaskPolicy.ts'

describe('task status policy', () => {
  it.each([
    ['pending', true, false],
    ['running', true, false],
    ['completed', false, true],
    ['interrupted', false, true],
    ['failed', false, true],
  ] as const)('classifies %s and applies the status filters', (status, active, terminal) => {
    expect(isActiveTaskStatus(status)).toBe(active)
    expect(isTerminalTaskStatus(status)).toBe(terminal)
    expect(matchesTaskStatusFilter(status, 'all')).toBe(true)
    expect(matchesTaskStatusFilter(status, 'active')).toBe(active)
    expect(matchesTaskStatusFilter(status, 'terminal')).toBe(terminal)
  })
})

describe('task workspace policy', () => {
  it('conflicts only when canonical directories are equal', () => {
    expect(workingDirectoriesConflict('/work/project', '/work/project')).toBe(true)
    expect(workingDirectoriesConflict('/work/project', '/work/project-copy')).toBe(false)
    expect(workingDirectoriesConflict('/work/project', '/work/project/subdirectory')).toBe(false)
  })

  it('accepts the channel workspace and its child directories', () => {
    expect(isWorkingDirectoryInsideWorkspace('/workspace', '/workspace/repo')).toBe(true)
    expect(isWorkingDirectoryInsideWorkspace('/workspace', '/workspace/tasks/task-1')).toBe(true)
    expect(isWorkingDirectoryInsideWorkspace('/workspace', '/workspace')).toBe(true)
    expect(isWorkingDirectoryInsideWorkspace('/workspace', '/')).toBe(false)
    expect(isWorkingDirectoryInsideWorkspace('/workspace', '/workspace-copy/repo')).toBe(false)
    expect(isWorkingDirectoryInsideWorkspace('/workspace', '/tmp/repo')).toBe(false)
  })
})
