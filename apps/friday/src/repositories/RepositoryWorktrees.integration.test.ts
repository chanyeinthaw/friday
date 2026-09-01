/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/node-builtin-import -- Bun runs this integration test against real temporary Git repositories; Effect execution is the explicit test boundary. */

import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Schema from 'effect/Schema'

import * as Effect from 'effect/Effect'

import {
  acquireRegistryLock,
  inspectRepositoryWorktree,
  ManagedWorktree,
  ManagedWorktreeListEntry,
  registryLockPath,
  releaseRegistryLock,
  removeRepositoryWorktree,
} from './RepositoryWorktrees.ts'

const temporaryDirectories: Array<string> = []
const decodeWorktree = Schema.decodeSync(Schema.fromJsonString(ManagedWorktree))
const decodeWorktreeList = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(ManagedWorktreeListEntry)),
)
const decodeRegistryPaths = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ worktrees: Schema.Array(Schema.Struct({ path: Schema.String })) }),
  ),
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

// Spawns several Friday CLI subprocesses; the combined startup cost exceeds
// Bun's default 5s timeout on CI runners, so allow more headroom explicitly.
test('lists managed worktrees from the persisted Friday registry', async () => {
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
}, 20_000)

test('keeps concurrent registry updates from separate Friday processes', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-concurrency-test-')
  const fridayHome = join(root, 'friday-home')
  const sources = [join(root, 'source-one'), join(root, 'source-two')]
  const workspaces = [join(root, 'workspace-one'), join(root, 'workspace-two')]
  await Promise.all(
    sources.map(async (source) => {
      await command(['git', 'init', '--initial-branch=main', source])
      await Bun.write(join(source, 'README.md'), `${source}\n`)
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
    }),
  )
  await Promise.all(
    sources.map((source, index) =>
      command(
        [
          'bun',
          'run',
          './src/main.ts',
          'worktree',
          'ensure',
          source,
          '--workspace',
          workspaces[index]!,
          '--json',
        ],
        { FRIDAY_HOME: fridayHome, NODE_ENV: 'test' },
      ),
    ),
  )
  const registry = decodeRegistryPaths(
    await readFile(join(fridayHome, 'repositories', 'worktrees.json'), 'utf8'),
  )
  expect(registry.worktrees.map((entry) => entry.path).toSorted()).toEqual(
    sources.map((source, index) => join(workspaces[index]!, source.split('/').at(-1)!)).toSorted(),
  )
})

test('waits for an ordinary live-owner contention instead of failing', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-lock-contention-')
  const fridayHome = join(root, 'friday-home')
  const holder = await Effect.runPromise(acquireRegistryLock(fridayHome))
  const source = join(root, 'source')
  const workspace = join(root, 'workspace')
  await command(['git', 'init', '--initial-branch=main', source])
  await Bun.write(join(source, 'README.md'), 'contention\n')
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

  const contender = command(
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
  await Bun.sleep(150)
  expect(await Bun.file(join(fridayHome, 'repositories', 'worktrees.json')).exists()).toBe(false)
  await Effect.runPromise(releaseRegistryLock(holder))
  const ensured = decodeWorktree(await contender)
  expect(ensured.path).toBe(join(workspace, 'source'))
})

test('recovers a lock whose recorded owner is dead', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-lock-stale-')
  const fridayHome = join(root, 'friday-home')
  const lockPath = registryLockPath(fridayHome)
  await mkdir(lockPath, { recursive: true })
  const token = crypto.randomUUID()
  await writeFile(
    join(lockPath, `owner-${token}.json`),
    JSON.stringify({
      token,
      pid: 2_147_483_647,
      startedAt: '2000-01-01T00:00:00.000Z',
      processStartId: null,
    }),
  )

  const holder = await Effect.runPromise(acquireRegistryLock(fridayHome))
  await Effect.runPromise(releaseRegistryLock(holder))
  expect(await Bun.file(lockPath).exists()).toBe(false)
})

test('reclaims a reused Linux pid when the recorded process start id differs', async () => {
  if (process.platform !== 'linux') return
  const root = await makeTemporaryDirectory('friday-worktree-lock-pid-reuse-')
  const fridayHome = join(root, 'friday-home')
  const lockPath = registryLockPath(fridayHome)
  await mkdir(lockPath, { recursive: true })
  const token = crypto.randomUUID()
  await writeFile(
    join(lockPath, `owner-${token}.json`),
    JSON.stringify({
      token,
      pid: process.pid,
      startedAt: '2000-01-01T00:00:00.000Z',
      processStartId: 'definitely-not-this-process',
    }),
  )

  const holder = await Effect.runPromise(
    acquireRegistryLock(fridayHome, { timeoutMs: 500, retryMs: 5 }),
  )
  await Effect.runPromise(releaseRegistryLock(holder))
  expect(await Bun.file(lockPath).exists()).toBe(false)
})

test('malformed lock metadata fails closed until the configured timeout', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-lock-malformed-')
  const fridayHome = join(root, 'friday-home')
  const lockPath = registryLockPath(fridayHome)
  await mkdir(lockPath, { recursive: true })
  const ownerPath = join(lockPath, 'owner-malformed.json')
  await writeFile(ownerPath, '{not valid metadata')

  const startedAt = performance.now()
  const exit = await Effect.runPromiseExit(
    acquireRegistryLock(fridayHome, { timeoutMs: 80, retryMs: 5 }),
  )
  expect(exit._tag).toBe('Failure')
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(60)
  expect(await Bun.file(ownerPath).exists()).toBe(true)
})

test('does not reclaim a live owner solely because its metadata is old', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-lock-live-old-')
  const fridayHome = join(root, 'friday-home')
  const lockPath = registryLockPath(fridayHome)
  await mkdir(lockPath, { recursive: true })
  const token = crypto.randomUUID()
  await writeFile(
    join(lockPath, `owner-${token}.json`),
    JSON.stringify({
      token,
      pid: process.pid,
      startedAt: '2000-01-01T00:00:00.000Z',
      processStartId: null,
    }),
  )

  const contender = Effect.runPromiseExit(acquireRegistryLock(fridayHome))
  await Bun.sleep(150)
  expect(await Bun.file(join(lockPath, `owner-${token}.json`)).exists()).toBe(true)
  await rm(lockPath, { recursive: true, force: true })
  const exit = await contender
  expect(exit._tag).toBe('Success')
  if (exit._tag === 'Success') await Effect.runPromise(releaseRegistryLock(exit.value))
})

test('release leaves a lock untouched when the on-disk owner token changed', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-lock-release-token-')
  const fridayHome = join(root, 'friday-home')
  const holder = await Effect.runPromise(acquireRegistryLock(fridayHome))
  const ownerFiles = await Array.fromAsync(
    new Bun.Glob('owner-*.json').scan(registryLockPath(fridayHome)),
  )
  expect(ownerFiles.length).toBe(1)
  const ownerPath = join(registryLockPath(fridayHome), ownerFiles[0]!)
  await writeFile(
    ownerPath,
    JSON.stringify({
      token: crypto.randomUUID(),
      pid: process.pid,
      startedAt: '2000-01-01T00:00:00.000Z',
      processStartId: null,
    }),
  )

  await Effect.runPromise(releaseRegistryLock(holder))
  expect(await Bun.file(ownerPath).exists()).toBe(true)
})

test('release cannot remove a successor token installed after the old owner moved', async () => {
  const root = await makeTemporaryDirectory('friday-worktree-lock-successor-race-')
  const fridayHome = join(root, 'friday-home')
  const holder = await Effect.runPromise(acquireRegistryLock(fridayHome))
  const lockPath = registryLockPath(fridayHome)
  const successorToken = crypto.randomUUID()
  const successorPath = join(lockPath, `owner-${successorToken}.json`)

  await rm(holder.ownerPath)
  await writeFile(
    successorPath,
    JSON.stringify({
      token: successorToken,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      processStartId: null,
    }),
  )
  await Effect.runPromise(releaseRegistryLock(holder))

  expect(await Bun.file(successorPath).exists()).toBe(true)
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
  await Effect.runPromise(removeRepositoryWorktree(snapshot, fridayHome))
  expect(await Bun.file(created.path).exists()).toBe(false)
})
