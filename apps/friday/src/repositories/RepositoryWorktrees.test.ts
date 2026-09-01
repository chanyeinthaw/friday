/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/node-builtin-import -- This vitest suite drives the real git and registry boundary so mutation testing covers the whole module. */

import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  createIsolatedWorktree,
  ensureRepositoryWorktree,
  inspectRepositoryWorktree,
  listManagedWorktrees,
  parseWorktreePorcelain,
  readWorktreeRegistry,
  removeRepositoryWorktree,
  RepositoryUrl,
  RepositoryWorktreeError,
  splitRepositoryLocation,
  worktreeRegistryPath,
} from './RepositoryWorktrees.ts'

const decodeRepositoryUrlSync = Schema.decodeSync(RepositoryUrl)
const isWorktreeError = Schema.is(RepositoryWorktreeError)

const exec = promisify(execFile)

const commitAll = async (cwd: string, message: string) => {
  await exec('git', ['add', '-A'], { cwd })
  await exec(
    'git',
    ['-c', 'user.name=Friday', '-c', 'user.email=friday@example.com', 'commit', '-m', message],
    { cwd },
  )
}

const git = async (cwd: string | undefined, ...arguments_: ReadonlyArray<string>) => {
  await exec('git', [...arguments_], cwd === undefined ? {} : { cwd })
}

const makeSourceRepository = (root: string, name: string) =>
  Effect.gen(function* () {
    const source = join(root, name)
    yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', source]))
    yield* Effect.promise(() => writeFile(join(source, 'README.md'), `${name}\n`, 'utf8'))
    yield* Effect.promise(() => commitAll(source, 'initial'))
    return { source, url: decodeRepositoryUrlSync(source) }
  })

describe('RepositoryWorktrees', () => {
  it.effect('registers an ensured worktree and lists it from the registry', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-unit-')))
      const home = join(root, 'friday-home')
      const workspace = join(root, 'workspace')
      const { source, url } = yield* makeSourceRepository(root, 'source-repository')

      const created = yield* ensureRepositoryWorktree({ url, workspaceRoot: workspace }, home)
      assert.strictEqual(created.reused, false)
      assert(created.commonDirectory.startsWith(join(home, 'repositories')))

      // The lifecycle write persisted a decodable registry entry.
      const registry = yield* readWorktreeRegistry(home)
      assert(registry !== null)
      assert.deepStrictEqual(
        registry.worktrees.map((entry) => entry.path),
        [created.path],
      )
      assert.strictEqual(registry.worktrees[0]!.url, source)
      assert.strictEqual(registry.version, 1)
      assert.strictEqual(created.path, join(workspace, 'source-repository'))

      const listed = yield* listManagedWorktrees(home)
      assert.strictEqual(listed.length, 1)
      assert.strictEqual(listed[0]!.path, created.path)
      assert.strictEqual(listed[0]!.branch, created.branch)
      assert.strictEqual(listed[0]!.url, source)
      assert.strictEqual(listed[0]!.commonDirectory, created.commonDirectory)
      assert.strictEqual(listed[0]!.prunable, false)
      assert.match(listed[0]!.head, /^[0-9a-f]{40}$/)

      // Ensuring again adopts the same worktree and refreshes the entry.
      const reused = yield* ensureRepositoryWorktree({ url, workspaceRoot: workspace }, home)
      assert.strictEqual(reused.reused, true)
      assert.strictEqual(reused.path, created.path)
      assert.strictEqual((yield* listManagedWorktrees(home)).length, 1)

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect(
    'treats a missing registry as unknown ownership and trusts only explicit registrations',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), 'friday-worktree-backfill-')),
        )
        const home = join(root, 'friday-home')
        const { url } = yield* makeSourceRepository(root, 'legacy-source')
        const cache = join(home, 'repositories', 'legacy.git')
        const legacyWorktree = join(root, 'legacy-worktree')

        // Pre-registry state: a bare cache with one linked worktree, plus an
        // unrelated bare cache with its own worktree dropped in later.
        yield* Effect.promise(() => exec('git', ['clone', '--bare', url, cache]))
        yield* Effect.promise(() =>
          git(
            undefined,
            '--git-dir',
            cache,
            'worktree',
            'add',
            '-b',
            'friday/legacy',
            legacyWorktree,
            'main',
          ),
        )

        // A second, alphabetically smaller worktree is created afterwards in
        // the same cache; it uses a detached head.
        const detachedWorktree = join(root, 'aaa-worktree')
        yield* Effect.promise(() =>
          git(
            undefined,
            '--git-dir',
            cache,
            'worktree',
            'add',
            '--detach',
            detachedWorktree,
            'main',
          ),
        )

        // Without durable metadata Friday cannot distinguish these legacy
        // cache worktrees from arbitrary cache contents, so listing is empty.
        assert.deepStrictEqual(yield* listManagedWorktrees(home), [])
        assert.strictEqual(yield* readWorktreeRegistry(home), null)

        // An arbitrary cache with a worktree is likewise not claimed.
        const stranger = join(home, 'repositories', 'stranger.git')
        yield* Effect.promise(() => exec('git', ['clone', '--bare', url, stranger]))
        yield* Effect.promise(() =>
          git(
            undefined,
            '--git-dir',
            stranger,
            'worktree',
            'add',
            '-b',
            'other/project',
            join(root, 'stranger-worktree'),
            'main',
          ),
        )
        // A stray file or non-git directory in the cache directory is not a
        // Friday cache at all.
        yield* Effect.promise(() => writeFile(join(home, 'repositories', 'stray.git'), 'x'))
        yield* Effect.promise(() => mkdir(join(home, 'repositories', 'notes')))
        assert.deepStrictEqual(yield* listManagedWorktrees(home), [])

        // A lifecycle operation can safely adopt and register an existing
        // worktree because its exact path and remote are known.
        const adoptedWorkspace = join(root, 'adopted-workspace')
        const adoptedPath = join(adoptedWorkspace, 'legacy-source')
        yield* Effect.promise(() => mkdir(adoptedWorkspace, { recursive: true }))
        yield* Effect.promise(() => exec('git', ['clone', url, adoptedPath]))
        const adopted = yield* ensureRepositoryWorktree(
          { url, workspaceRoot: adoptedWorkspace },
          home,
        )
        assert.strictEqual(adopted.reused, true)
        assert.deepStrictEqual(
          (yield* listManagedWorktrees(home)).map((entry) => entry.path),
          [adoptedPath],
        )

        yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
      }).pipe(Effect.scoped),
  )

  it.effect('registers isolated task worktrees in the external primary repository', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-isolated-')))
      const home = join(root, 'friday-home')
      const primary = join(root, 'primary')
      const origin = join(root, 'origin.git')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', primary]))
      yield* Effect.promise(() => exec('git', ['init', '--bare', origin]))
      yield* Effect.promise(() => exec('git', ['-C', primary, 'remote', 'add', 'origin', origin]))
      yield* Effect.promise(() => writeFile(join(primary, 'README.md'), 'primary\n', 'utf8'))
      yield* Effect.promise(() => commitAll(primary, 'initial'))
      yield* Effect.promise(() => exec('git', ['-C', primary, 'push', '-q', 'origin', 'main']))

      const isolated = yield* createIsolatedWorktree(
        { primaryWorktree: primary, taskId: 'task-abc123' },
        home,
      )
      assert.strictEqual(isolated.reused, false)
      assert.strictEqual(isolated.branch, 'friday/task/abc123')
      // Long task ids are truncated to 12 safe characters.
      const longTask = yield* createIsolatedWorktree(
        { primaryWorktree: primary, taskId: 'task-abcdefghijklmno' },
        home,
      )
      assert.strictEqual(longTask.branch, 'friday/task/abcdefghijkl')
      // A task id that merely contains 'task-' keeps its full safe form.
      const innerTask = yield* createIsolatedWorktree(
        { primaryWorktree: primary, taskId: 'x-task-abc' },
        home,
      )
      assert.strictEqual(innerTask.branch, 'friday/task/x-task-abc')
      assert.strictEqual(isolated.commonDirectory, join(primary, '.git'))

      // The isolated worktrees are registered and listed through git's
      // registry of the external primary repository, not through any cache.
      const listed = yield* listManagedWorktrees(home)
      assert.deepStrictEqual(
        listed.map((entry) => entry.path),
        [isolated.path, longTask.path, innerTask.path],
      )
      assert.strictEqual(listed[0]!.branch, 'friday/task/abc123')
      assert.strictEqual(listed[0]!.commonDirectory, join(primary, '.git'))

      // Creating the same isolated worktree again reuses and keeps one entry.
      const again = yield* createIsolatedWorktree(
        { primaryWorktree: primary, taskId: 'task-abc123' },
        home,
      )
      assert.strictEqual(again.reused, true)
      assert.strictEqual(again.path, isolated.path)
      assert.strictEqual((yield* listManagedWorktrees(home)).length, 3)

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('removal unregisters only the removed worktree and keeps other branches', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-remove-')))
      const home = join(root, 'friday-home')
      const firstWorkspace = join(root, 'first-workspace')
      const secondWorkspace = join(root, 'second-workspace')
      const { url } = yield* makeSourceRepository(root, 'removable')
      const first = yield* ensureRepositoryWorktree({ url, workspaceRoot: firstWorkspace }, home)
      const second = yield* ensureRepositoryWorktree({ url, workspaceRoot: secondWorkspace }, home)
      // Distinct workspace roots produce distinct branches in one cache.
      assert.notStrictEqual(first.branch, second.branch)
      assert.strictEqual(first.commonDirectory, second.commonDirectory)
      const firstSnapshot = yield* inspectRepositoryWorktree(first.path)
      assert(firstSnapshot !== null)

      yield* removeRepositoryWorktree(firstSnapshot, home)

      const listed = yield* listManagedWorktrees(home)
      assert.deepStrictEqual(
        listed.map((entry) => entry.path),
        [second.path],
      )
      const registry = yield* readWorktreeRegistry(home)
      assert(registry !== null)
      assert.deepStrictEqual(
        registry.worktrees.map((entry) => entry.path),
        [second.path],
      )
      // The workspace branch of the removed worktree is kept; only
      // friday/task branches are deleted together with their worktree.
      yield* Effect.promise(() =>
        exec('git', ['-C', second.path, 'rev-parse', '--verify', `refs/heads/${first.branch}`]),
      )

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('removing an isolated worktree deletes its friday/task branch', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-task-')))
      const home = join(root, 'friday-home')
      const primary = join(root, 'primary')
      const origin = join(root, 'origin.git')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', primary]))
      yield* Effect.promise(() => exec('git', ['init', '--bare', origin]))
      yield* Effect.promise(() => exec('git', ['-C', primary, 'remote', 'add', 'origin', origin]))
      yield* Effect.promise(() => writeFile(join(primary, 'README.md'), 'primary\n', 'utf8'))
      yield* Effect.promise(() => commitAll(primary, 'initial'))
      const isolated = yield* createIsolatedWorktree(
        { primaryWorktree: primary, taskId: 'task-abc123' },
        home,
      )
      const snapshot = yield* inspectRepositoryWorktree(isolated.path)
      assert(snapshot !== null)

      yield* removeRepositoryWorktree(snapshot, home)

      const listed = yield* listManagedWorktrees(home)
      assert.deepStrictEqual(listed, [])
      const branchSurvived = yield* Effect.promise(() =>
        exec('git', ['-C', primary, 'rev-parse', '--verify', isolated.branch]).then(
          () => true,
          () => false,
        ),
      )
      assert.strictEqual(branchSurvived, false)

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('rejects a changed worktree snapshot with a typed validate error', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-stale-')))
      const home = join(root, 'friday-home')
      const workspace = join(root, 'workspace')
      const { url } = yield* makeSourceRepository(root, 'stale-repository')
      const created = yield* ensureRepositoryWorktree({ url, workspaceRoot: workspace }, home)
      const snapshot = yield* inspectRepositoryWorktree(created.path)
      assert(snapshot !== null)
      yield* Effect.promise(() => writeFile(join(created.path, 'late.txt'), 'late\n', 'utf8'))

      const error = yield* removeRepositoryWorktree(snapshot, home).pipe(Effect.flip)
      assert(isWorktreeError(error))
      assert.strictEqual(error.operation, 'validate')
      assert.strictEqual(
        error.message,
        `Worktree '${created.path}' changed after cleanup approval was requested.`,
      )
      // The worktree itself is untouched after the refusal.
      assert(
        yield* Effect.promise(() =>
          exec('git', ['-C', created.path, 'rev-parse', '--is-inside-work-tree']).then(
            () => true,
            () => false,
          ),
        ),
      )

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('resolves explicit refs and refuses refs that are absent from the cache', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-ref-')))
      const home = join(root, 'friday-home')
      const workspace = join(root, 'workspace')
      const { url } = yield* makeSourceRepository(root, 'ref-repository')

      const atMain = yield* ensureRepositoryWorktree(
        { url, workspaceRoot: workspace, ref: 'main' },
        home,
      )
      assert.strictEqual(atMain.baseRef, 'main')
      assert.match(atMain.branch, /^friday\//)
      const remoteMain = yield* Effect.promise(() =>
        exec('git', ['-C', atMain.path, 'rev-parse', 'HEAD']).then((v) => v.stdout.trim()),
      )
      const sourceMain = yield* Effect.promise(() =>
        exec('git', ['-C', url, 'rev-parse', 'main']).then((v) => v.stdout.trim()),
      )
      assert.strictEqual(remoteMain, sourceMain)

      // A ref that only exists on the remote resolves through origin/<ref>.
      yield* Effect.promise(() => exec('git', ['-C', url, 'branch', 'feature', 'main']))
      const atOriginFeature = yield* ensureRepositoryWorktree(
        { url, workspaceRoot: join(root, 'feature-workspace'), ref: 'feature' },
        home,
      )
      assert.strictEqual(atOriginFeature.baseRef, 'origin/feature')

      const absent = yield* ensureRepositoryWorktree(
        { url, workspaceRoot: join(root, 'other-workspace'), ref: 'nope' },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(absent))
      assert.strictEqual(absent.operation, 'resolve-ref')
      assert.strictEqual(absent.message, "Git ref 'nope' was not found in the repository cache.")

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('resolves the remote default branch through git and refuses without one', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-head-')))
      const home = join(root, 'friday-home')
      const source = join(root, 'trunk-repository')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=trunk', source]))
      yield* Effect.promise(() => writeFile(join(source, 'README.md'), 'trunk\n', 'utf8'))
      yield* Effect.promise(() => commitAll(source, 'initial'))

      const ensured = yield* ensureRepositoryWorktree(
        { url: decodeRepositoryUrlSync(source), workspaceRoot: join(root, 'workspace') },
        home,
      )
      // The symbolic remote head, not a hard-coded main or master, is used.
      assert.strictEqual(ensured.baseRef, 'remotes/origin/trunk')
      const headCommit = yield* Effect.promise(() =>
        exec('git', ['-C', ensured.path, 'rev-parse', 'HEAD']).then((v) => v.stdout.trim()),
      )
      const trunkCommit = yield* Effect.promise(() =>
        exec('git', ['-C', source, 'rev-parse', 'trunk']).then((v) => v.stdout.trim()),
      )
      assert.strictEqual(headCommit, trunkCommit)

      // A cache whose remote has no heads cannot resolve a default branch.
      const emptySource = join(root, 'empty-repository')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=trunk', emptySource]))
      const noHead = yield* ensureRepositoryWorktree(
        { url: decodeRepositoryUrlSync(emptySource), workspaceRoot: join(root, 'empty-workspace') },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(noHead))
      assert.strictEqual(noHead.operation, 'resolve-ref')
      assert.strictEqual(noHead.message, 'Could not resolve the remote default branch.')

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('refuses destinations that already exist or belong to another remote', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-dest-')))
      const home = join(root, 'friday-home')
      const { url } = yield* makeSourceRepository(root, 'dest-repository')
      const workspace = join(root, 'workspace')

      // A plain file at the destination is not a Git worktree.
      const fileDestination = join(workspace, 'dest-repository')
      yield* Effect.promise(() => mkdir(join(fileDestination, '..'), { recursive: true }))
      yield* Effect.promise(() => writeFile(fileDestination, 'not a worktree'))
      const fileRefusal = yield* ensureRepositoryWorktree(
        { url, workspaceRoot: workspace },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(fileRefusal))
      assert.strictEqual(fileRefusal.operation, 'validate')
      assert.strictEqual(
        fileRefusal.message,
        `Destination '${fileDestination}' already exists and is not a Git worktree.`,
      )

      // A directory at the destination that is a Git repository with another
      // remote is refused instead of adopted.
      const mismatchSource = join(root, 'mismatch')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', mismatchSource]))
      yield* Effect.promise(() => writeFile(join(mismatchSource, 'README.md'), 'm\n', 'utf8'))
      yield* Effect.promise(() => commitAll(mismatchSource, 'initial'))
      const mismatchDestination = join(workspace, 'mismatch')
      yield* Effect.promise(() =>
        exec('git', ['init', '--initial-branch=main', mismatchDestination]),
      )
      yield* Effect.promise(() =>
        exec('git', [
          '-C',
          mismatchDestination,
          'remote',
          'add',
          'origin',
          join(root, 'elsewhere.git'),
        ]),
      )
      const remoteRefusal = yield* ensureRepositoryWorktree(
        { url: decodeRepositoryUrlSync(mismatchSource), workspaceRoot: workspace },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(remoteRefusal))
      assert.strictEqual(remoteRefusal.operation, 'validate')
      assert.strictEqual(
        remoteRefusal.message,
        `Existing directory '${mismatchDestination}' belongs to a different Git remote.`,
      )

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('refuses an isolated destination that already exists', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-iso-')))
      const home = join(root, 'friday-home')
      const primary = join(root, 'primary')
      const origin = join(root, 'origin.git')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', primary]))
      yield* Effect.promise(() => exec('git', ['init', '--bare', origin]))
      yield* Effect.promise(() => exec('git', ['-C', primary, 'remote', 'add', 'origin', origin]))
      yield* Effect.promise(() => writeFile(join(primary, 'README.md'), 'primary\n', 'utf8'))
      yield* Effect.promise(() => commitAll(primary, 'initial'))
      yield* Effect.promise(() => mkdir(`${primary}--abc123`, { recursive: true }))

      const refusal = yield* createIsolatedWorktree(
        { primaryWorktree: primary, taskId: 'task-abc123' },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(refusal))
      assert.strictEqual(refusal.operation, 'validate')
      assert.strictEqual(
        refusal.message,
        `Isolated worktree destination '${primary}--abc123' already exists.`,
      )

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('returns no snapshot for directories that are not working trees', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-inspect-')))
      const plain = join(root, 'plain')
      const bare = join(root, 'bare.git')
      yield* Effect.promise(() => mkdir(plain, { recursive: true }))
      yield* Effect.promise(() => exec('git', ['init', '--bare', bare]))
      assert.strictEqual(yield* inspectRepositoryWorktree(plain), null)
      assert.strictEqual(yield* inspectRepositoryWorktree(bare), null)
      assert.strictEqual(yield* inspectRepositoryWorktree(join(root, 'missing')), null)

      // A repository whose HEAD points at a missing ref still counts as a
      // working tree, so the deeper inspection fails as a typed inspect error.
      const broken = join(root, 'broken')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', broken]))
      yield* Effect.promise(() =>
        writeFile(join(broken, '.git', 'HEAD'), 'ref: refs/heads/nonexistent', 'utf8'),
      )
      const error = yield* inspectRepositoryWorktree(broken).pipe(Effect.flip)
      assert(isWorktreeError(error))
      assert.strictEqual(error.operation, 'inspect')

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('derives deterministic cache, destination, and branch names', () =>
    Effect.gen(function* () {
      // URL splitting feeds both cache and destination naming.
      assert.deepStrictEqual(splitRepositoryLocation('https://github.com/o/r.git'), {
        host: 'github.com',
        path: 'o/r.git',
      })
      assert.deepStrictEqual(splitRepositoryLocation('https://user@gitlab.com/o/r'), {
        host: 'gitlab.com',
        path: 'o/r',
      })
      assert.deepStrictEqual(splitRepositoryLocation('git@github.com:o/r.git'), {
        host: 'github.com',
        path: 'o/r.git',
      })
      assert.deepStrictEqual(splitRepositoryLocation('https://github.com/o/r/'), {
        host: 'github.com',
        path: 'o/r',
      })
      assert.deepStrictEqual(splitRepositoryLocation('/local/path/repo.git'), {
        host: '',
        path: '/local/path/repo.git',
      })
      // An scp-style URL without a user still names its host.
      assert.deepStrictEqual(splitRepositoryLocation('myhost:repos/name.git'), {
        host: 'myhost',
        path: 'repos/name.git',
      })
      // Surrounding whitespace is trimmed before splitting.
      assert.deepStrictEqual(splitRepositoryLocation('  https://github.com/o/r.git '), {
        host: 'github.com',
        path: 'o/r.git',
      })

      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-naming-')))
      const home = join(root, 'friday-home')
      const named = join(root, 'named-repository.git')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', named]))
      yield* Effect.promise(() => writeFile(join(named, 'README.md'), 'n\n', 'utf8'))
      yield* Effect.promise(() => commitAll(named, 'initial'))

      // A long workspace name is truncated to 32 characters in the branch name.
      const longWorkspace = join(root, 'a-very-long-channel-workspace-name-exceeding-limits')
      const first = yield* ensureRepositoryWorktree(
        { url: decodeRepositoryUrlSync(named), workspaceRoot: longWorkspace },
        home,
      )
      assert.strictEqual(first.path, join(longWorkspace, 'named-repository'))
      assert.match(first.branch, /^friday\/[a-z0-9._+-]{32}\/[0-9a-f]{10}$/)
      // Unsafe characters collapse to single separators and edges are trimmed.
      const spacedWorkspace = join(root, '  spaced   workspace  ')
      const spaced = yield* ensureRepositoryWorktree(
        { url: decodeRepositoryUrlSync(named), workspaceRoot: spacedWorkspace },
        home,
      )
      assert.match(spaced.branch, /^friday\/spaced\+workspace\/[0-9a-f]{10}$/)

      // Only a trailing .git suffix is stripped from the destination name.
      const weird = join(root, 'foo.gitbar')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', weird]))
      yield* Effect.promise(() => writeFile(join(weird, 'README.md'), 'w\n', 'utf8'))
      yield* Effect.promise(() => commitAll(weird, 'initial'))
      const weirdEnsured = yield* ensureRepositoryWorktree(
        { url: decodeRepositoryUrlSync(weird), workspaceRoot: join(root, 'weird-workspace') },
        home,
      )
      assert.strictEqual(weirdEnsured.path, join(root, 'weird-workspace', 'foo.gitbar'))

      // A trailing slash on the URL still strips the .git suffix for the name.
      const second = yield* ensureRepositoryWorktree(
        {
          url: decodeRepositoryUrlSync(`${named}/`),
          workspaceRoot: join(root, 'second-workspace'),
        },
        home,
      )
      assert.strictEqual(second.path, join(root, 'second-workspace', 'named-repository'))
      // Different urls with the same trailing part still get distinct caches.
      assert.notStrictEqual(first.commonDirectory, second.commonDirectory)

      // Re-ensuring from another workspace reuses the existing bare cache.
      const third = yield* ensureRepositoryWorktree(
        { url: decodeRepositoryUrlSync(named), workspaceRoot: join(root, 'third-workspace') },
        home,
      )
      assert.strictEqual(third.commonDirectory, first.commonDirectory)

      // Every ensured worktree is registered exactly once, sorted by path.
      const registry = yield* readWorktreeRegistry(home)
      assert(registry !== null)
      const paths = registry.worktrees.map((entry) => entry.path)
      assert.strictEqual(paths.length, 5)
      assert.deepStrictEqual(paths, paths.toSorted())
      assert(paths.includes(first.path))
      assert(paths.includes(weirdEnsured.path))

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('fails typed when the registry file is malformed', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-corrupt-')))
      const home = join(root, 'friday-home')
      yield* Effect.promise(() => mkdir(join(home, 'repositories'), { recursive: true }))
      yield* Effect.promise(() => writeFile(worktreeRegistryPath(home), '{ not json', 'utf8'))
      const exit = yield* Effect.exit(listManagedWorktrees(home))
      assert(Effect.isFailure(exit))
      const error = yield* listManagedWorktrees(home).pipe(Effect.flip)
      assert(isWorktreeError(error))
      assert.match(error.message, /registry .* is invalid/)
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('re-ensuring a pruned worktree reuses the branch registered in the cache', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-prune-')))
      const home = join(root, 'friday-home')
      const workspace = join(root, 'workspace')
      const { url } = yield* makeSourceRepository(root, 'prunable')
      const first = yield* ensureRepositoryWorktree({ url, workspaceRoot: workspace }, home)
      // Remove the worktree directory and let git forget the registration.
      yield* Effect.promise(() => rm(first.path, { recursive: true, force: true }))
      yield* Effect.promise(() =>
        git(undefined, '--git-dir', first.commonDirectory, 'worktree', 'prune'),
      )

      const second = yield* ensureRepositoryWorktree({ url, workspaceRoot: workspace }, home)
      assert.strictEqual(second.reused, false)
      // The branch created for this workspace still exists and is reused.
      assert.strictEqual(second.branch, first.branch)
      assert.strictEqual(second.commonDirectory, first.commonDirectory)

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('surfaces isolated and cache failures as typed errors with their operation', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-fail-')))
      const home = join(root, 'friday-home')

      // Isolated creation from a plain directory fails the common-dir probe.
      const plain = join(root, 'plain')
      yield* Effect.promise(() => mkdir(plain, { recursive: true }))
      const isolatedFailure = yield* createIsolatedWorktree(
        { primaryWorktree: plain, taskId: 'task-abc' },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(isolatedFailure))
      assert.strictEqual(isolatedFailure.operation, 'inspect')

      // Isolated creation from a repository without commits fails HEAD.
      const emptyPrimary = join(root, 'empty-primary')
      const emptyOrigin = join(root, 'empty-origin.git')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', emptyPrimary]))
      yield* Effect.promise(() => exec('git', ['init', '--bare', emptyOrigin]))
      yield* Effect.promise(() =>
        exec('git', ['-C', emptyPrimary, 'remote', 'add', 'origin', emptyOrigin]),
      )
      const headFailure = yield* createIsolatedWorktree(
        { primaryWorktree: emptyPrimary, taskId: 'task-abc' },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(headFailure))
      assert.strictEqual(headFailure.operation, 'inspect')

      // Isolated creation from a repository without an origin remote fails.
      const noRemote = join(root, 'no-remote')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', noRemote]))
      yield* Effect.promise(() => writeFile(join(noRemote, 'README.md'), 'x', 'utf8'))
      yield* Effect.promise(() => commitAll(noRemote, 'initial'))
      const remoteFailure = yield* createIsolatedWorktree(
        { primaryWorktree: noRemote, taskId: 'task-abc' },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(remoteFailure))
      assert.strictEqual(remoteFailure.operation, 'inspect')

      // Ensuring from a repository that cannot be cloned fails as clone.
      const ensureFailure = yield* ensureRepositoryWorktree(
        {
          url: decodeRepositoryUrlSync(join(root, 'not-a-repository')),
          workspaceRoot: join(root, 'workspace'),
        },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(ensureFailure))
      assert.strictEqual(ensureFailure.operation, 'clone')

      // Arbitrary cache directories are ignored when no registry exists.
      const corruptHome = join(root, 'corrupt-home')
      yield* Effect.promise(() =>
        mkdir(join(corruptHome, 'repositories', 'corrupt.git'), { recursive: true }),
      )
      assert.deepStrictEqual(yield* listManagedWorktrees(corruptHome), [])

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('refuses reused destinations that never committed and pre-existing task branches', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-edge-')))
      const home = join(root, 'friday-home')

      // An adopted directory with a matching remote but no commits has no
      // branch to report and no head to build from.
      const origin = join(root, 'origin.git')
      const unborn = join(root, 'unborn')
      const unbornWorkspace = join(root, 'unborn-workspace')
      yield* Effect.promise(() => exec('git', ['init', '--bare', origin]))
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', unborn]))
      yield* Effect.promise(() => exec('git', ['-C', unborn, 'remote', 'add', 'origin', origin]))
      yield* Effect.promise(() => mkdir(unbornWorkspace, { recursive: true }))
      const unbornDestination = join(unbornWorkspace, 'origin')
      yield* Effect.promise(() => exec('git', ['clone', origin, unbornDestination]))
      const unbornRefusal = yield* ensureRepositoryWorktree(
        { url: decodeRepositoryUrlSync(origin), workspaceRoot: unbornWorkspace },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(unbornRefusal))
      assert.strictEqual(unbornRefusal.operation, 'inspect')

      // A friday/task branch that already exists cannot be created again.
      const primary = join(root, 'primary')
      const primaryOrigin = join(root, 'primary-origin.git')
      yield* Effect.promise(() => exec('git', ['init', '--initial-branch=main', primary]))
      yield* Effect.promise(() => exec('git', ['init', '--bare', primaryOrigin]))
      yield* Effect.promise(() =>
        exec('git', ['-C', primary, 'remote', 'add', 'origin', primaryOrigin]),
      )
      yield* Effect.promise(() => writeFile(join(primary, 'README.md'), 'x', 'utf8'))
      yield* Effect.promise(() => commitAll(primary, 'initial'))
      yield* Effect.promise(() =>
        exec('git', ['-C', primary, 'branch', 'friday/task/abc123', 'main']),
      )
      const branchRefusal = yield* createIsolatedWorktree(
        { primaryWorktree: primary, taskId: 'task-abc123' },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(branchRefusal))
      assert.strictEqual(branchRefusal.operation, 'create')

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('surfaces worktree registry read and write failures as typed errors', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-worktree-reg-')))
      const home = join(root, 'friday-home')
      const workspace = join(root, 'workspace')
      const { url } = yield* makeSourceRepository(root, 'registered')

      // An unreadable registry file is a typed failure, never silent state.
      const { chmod } = yield* Effect.promise(() => import('node:fs/promises'))
      const registryFile = worktreeRegistryPath(home)
      yield* Effect.promise(() => mkdir(join(home, 'repositories'), { recursive: true }))
      yield* Effect.promise(() => writeFile(registryFile, '{"version":1,"worktrees":[]}'))
      yield* Effect.promise(() => chmod(registryFile, 0o000))
      const readFailure = yield* readWorktreeRegistry(home).pipe(Effect.flip)
      assert(isWorktreeError(readFailure))
      assert.strictEqual(readFailure.operation, 'inspect')
      yield* Effect.promise(() => chmod(registryFile, 0o644))

      // When the registry destination cannot be replaced, the lifecycle
      // write fails typed instead of dropping the registration silently.
      yield* ensureRepositoryWorktree({ url, workspaceRoot: workspace }, home)
      yield* Effect.promise(() => rm(registryFile))
      yield* Effect.promise(() => mkdir(registryFile))
      const writeFailure = yield* ensureRepositoryWorktree(
        { url, workspaceRoot: join(root, 'other-workspace') },
        home,
      ).pipe(Effect.flip)
      assert(isWorktreeError(writeFailure))
      assert.strictEqual(writeFailure.operation, 'inspect')

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }).pipe(Effect.scoped),
  )

  it.effect('parses porcelain worktree records', () =>
    Effect.sync(() => {
      const records = parseWorktreePorcelain(
        [
          'worktree /repos/cache.git',
          'bare',
          '',
          'worktree /tmp/channel/one',
          'HEAD a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
          'branch refs/heads/friday/channel/abc',
          '',
          'worktree /tmp/channel/two',
          'HEAD b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
          'detached',
          'prunable git worktree prune',
        ].join('\n'),
      )
      assert.strictEqual(records.length, 3)
      assert.deepStrictEqual(records[0], { path: '/repos/cache.git', bare: true })
      assert.deepStrictEqual(records[1], {
        path: '/tmp/channel/one',
        head: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        branch: 'friday/channel/abc',
      })
      assert.deepStrictEqual(records[2], {
        path: '/tmp/channel/two',
        head: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
        detached: true,
        prunable: true,
      })
      // A missing HEAD leaves the head field unset.
      assert.deepStrictEqual(parseWorktreePorcelain('worktree /x\n')[0], { path: '/x' })
    }),
  )
})
