/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- This integration test exercises the real Friday CLI and temporary Git repositories. */

import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Schema from 'effect/Schema'

import { ManagedWorktree } from './RepositoryWorktrees.ts'

const temporaryDirectories: Array<string> = []
const decodeWorktree = Schema.decodeSync(Schema.fromJsonString(ManagedWorktree))

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
