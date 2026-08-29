import { describe, expect, it } from 'vitest'

import {
  isActiveTaskStatus,
  isTerminalTaskStatus,
  matchesTaskStatusFilter,
  workingDirectoriesConflict,
} from './TaskPolicy.ts'

const statuses = ['pending', 'running', 'completed', 'interrupted', 'failed'] as const

describe('task status policy', () => {
  it.each([
    ['pending', true, false],
    ['running', true, false],
    ['completed', false, true],
    ['interrupted', false, true],
    ['failed', false, true],
  ] as const)('classifies %s', (status, active, terminal) => {
    expect(isActiveTaskStatus(status)).toBe(active)
    expect(isTerminalTaskStatus(status)).toBe(terminal)
  })

  it.each(statuses)('matches all for %s', (status) => {
    expect(matchesTaskStatusFilter(status, 'all')).toBe(true)
  })

  it.each(statuses)('matches active and terminal filters exclusively for %s', (status) => {
    expect(matchesTaskStatusFilter(status, 'active')).toBe(isActiveTaskStatus(status))
    expect(matchesTaskStatusFilter(status, 'terminal')).toBe(isTerminalTaskStatus(status))
  })
})

describe('task workspace policy', () => {
  it('conflicts only when canonical directories are equal', () => {
    expect(workingDirectoriesConflict('/work/project', '/work/project')).toBe(true)
    expect(workingDirectoriesConflict('/work/project', '/work/project-copy')).toBe(false)
    expect(workingDirectoriesConflict('/work/project', '/work/project/subdirectory')).toBe(false)
  })
})
