/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/node-builtin-import -- Bun runs this integration test against real temporary Git repositories; Effect execution is the explicit test boundary. */

import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Schema from 'effect/Schema'

import * as Effect from 'effect/Effect'

import {
  inspectRepositoryWorktree,
  ManagedWorktree,
  ManagedWorktreeListEntry,
  removeRepositoryWorktree,
} from './RepositoryWorktrees.ts'

const temporaryDirectories: Array<string> = []
const decodeWorktree = Schema.decodeSync(Schema.fromJsonString(ManagedWorktree))
const decodeWorktreeList = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(ManagedWorktreeListEntry)),
)

const makeTemporaryDirectory = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const command = async (arguments_: ReadonlyArray<string>, environment?: Record<string, string>) => {
  const process = Bun.spawn(Array.from(arguments_), {
    cwd: join(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: environment === undefined ? Bun.env : { ...Bun.env, ...environment },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test('creates and reuses one managed worktree in the channel workspace', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-test-')
  const source = join(root, 'source-repository')
  const workspace = join(root, 'workspace')
  const fridayHome = join(root, 'friday-home')
  await Promise.all([Bun.write(join(source, '.keep'), ''), Bun.write(join(workspace, '.keep'), '')])
  await command(['git', 'init', '--initial-branch=main', source])
  await Bun.write(join(source, 'README.md'), 'Friday worktree test\n')
  await command(['git', '-C', source, 'add', 'README.md'])
  await command([
    'git',
    '-C',
    source,
    '-c',
    'user.name=Friday',
    '-c',
    'user.email=friday@example.com',
    'commit',
    '-m',
    'initial',
  ])

  const runFriday = () =>
    command(
      [
        'bun',
        'run',
        './src/main.ts',
        'worktree',
        'ensure',
        source,
        '--workspace',
        workspace,
        '--json',
      ],
      { FRIDAY_HOME: fridayHome, NODE_ENV: 'test' },
    )
  const first = decodeWorktree(await runFriday())
  const second = decodeWorktree(await runFriday())

  expect(first.path).toBe(join(workspace, 'source-repository'))
  expect(first.reused).toBe(false)
  expect(second.path).toBe(first.path)
  expect(second.branch).toBe(first.branch)
  expect(second.reused).toBe(true)
  expect(await Bun.file(join(first.path, 'README.md')).text()).toBe('Friday worktree test\n')
})

test('lists managed worktrees from the persisted repository caches', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-list-test-')
  const source = join(root, 'source-repository')
  const workspace = join(root, 'workspace')
  const fridayHome = join(root, 'friday-home')
  await Promise.all([Bun.write(join(source, '.keep'), ''), Bun.write(join(workspace, '.keep'), '')])
  await command(['git', 'init', '--initial-branch=main', source])
  await Bun.write(join(source, 'README.md'), 'Friday worktree list test\n')
  await command(['git', '-C', source, 'add', 'README.md'])
  await command([
    'git',
    '-C',
    source,
    '-c',
    'user.name=Friday',
    '-c',
    'user.email=friday@example.com',
    'commit',
    '-m',
    'initial',
  ])

  const runFriday = (arguments_: ReadonlyArray<string>) =>
    command(['bun', 'run', './src/main.ts', ...arguments_], {
      FRIDAY_HOME: fridayHome,
      NODE_ENV: 'test',
    })

  // Before any worktree exists the listing is empty and succeeds.
  expect(await runFriday(['worktree', 'list', '--json'])).toBe('[]')

  const ensured = decodeWorktree(
    await runFriday(['worktree', 'ensure', source, '--workspace', workspace, '--json']),
  )
  const listed = decodeWorktreeList(await runFriday(['worktree', 'list', '--json']))
  expect(listed.length).toBe(1)
  expect(listed[0]!.path).toBe(ensured.path)
  expect(listed[0]!.branch).toBe(ensured.branch)
  // The porcelain listing reports the concrete head commit.
  expect(listed[0]!.head).toMatch(/^[0-9a-f]{40}$/)
  expect(listed[0]!.url).toBe(source)
  expect(listed[0]!.prunable).toBe(false)

  // The human listing names the worktree path and branch without JSON brackets.
  const human = await runFriday(['worktree', 'list'])
  expect(human.includes(ensured.path)).toBe(true)
  expect(human.includes(ensured.branch)).toBe(true)
  expect(human.startsWith('[')).toBe(false)

  // Deleting the worktree directory out-of-band shows up as prunable state, not an error.
  await rm(listed[0]!.path, { recursive: true, force: true })
  const pruned = decodeWorktreeList(await runFriday(['worktree', 'list', '--json']))
  expect(pruned.length).toBe(1)
  expect(pruned[0]!.prunable).toBe(true)
})

test('removes an approved dirty worktree after revalidating its snapshot', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-cleanup-test-')
  const source = join(root, 'source-repository')
  const workspace = join(root, 'workspace')
  const fridayHome = join(root, 'friday-home')
  await Promise.all([Bun.write(join(source, '.keep'), ''), Bun.write(join(workspace, '.keep'), '')])
  await command(['git', 'init', '--initial-branch=main', source])
  await Bun.write(join(source, 'README.md'), 'Initial\n')
  await command(['git', '-C', source, 'add', 'README.md'])
  await command([
    'git',
    '-C',
    source,
    '-c',
    'user.name=Friday',
    '-c',
    'user.email=friday@example.com',
    'commit',
    '-m',
    'initial',
  ])
  const created = decodeWorktree(
    await command(
      [
        'bun',
        'run',
        './src/main.ts',
        'worktree',
        'ensure',
        source,
        '--workspace',
        workspace,
        '--json',
      ],
      { FRIDAY_HOME: fridayHome, NODE_ENV: 'test' },
    ),
  )
  await Bun.write(join(created.path, 'dirty.txt'), 'discard me\n')
  const snapshot = await Effect.runPromise(inspectRepositoryWorktree(created.path))
  expect(snapshot).not.toBeNull()
  if (snapshot === null) return
  expect(snapshot.status).toContain('?? dirty.txt')
  await Effect.runPromise(removeRepositoryWorktree(snapshot))
  expect(await Bun.file(created.path).exists()).toBe(false)
})
