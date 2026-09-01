/* oxlint-disable effecttsgo/node-builtin-import -- Repository paths and stable hashes use Node's standard library. */

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { FRIDAY_HOME } from '../FridayHome.ts'

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))
export const RepositoryUrl = NonEmptyString.pipe(Schema.brand('RepositoryUrl'))
export type RepositoryUrl = typeof RepositoryUrl.Type

export const ManagedWorktree = Schema.Struct({
  url: RepositoryUrl,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  cachePath: Schema.String,
  reused: Schema.Boolean,
})
export type ManagedWorktree = typeof ManagedWorktree.Type

export const RepositoryWorktreeSnapshot = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  head: Schema.String,
  commonDirectory: Schema.String,
  status: Schema.String,
  sizeBytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type RepositoryWorktreeSnapshot = typeof RepositoryWorktreeSnapshot.Type

export class RepositoryWorktreeError extends Schema.Error<RepositoryWorktreeError>(
  'RepositoryWorktreeError',
)({
  _tag: Schema.tag('RepositoryWorktreeError'),
  operation: Schema.Literals([
    'inspect',
    'clone',
    'fetch',
    'resolve-ref',
    'create',
    'validate',
    'remove',
  ]),
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail
  }
}

interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const runGit = Effect.fn('RepositoryWorktrees.git')(function* (arguments_: ReadonlyArray<string>) {
  const result = yield* Effect.tryPromise({
    try: async (): Promise<GitResult> => {
      const process = Bun.spawn(['git', ...arguments_], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...Bun.env, GIT_TERMINAL_PROMPT: '0' },
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
    },
    catch: (cause) =>
      new RepositoryWorktreeError({
        operation: 'inspect',
        detail: `Failed to run git ${arguments_.join(' ')}.`,
        cause,
      }),
  })
  return result
})

const requireGit = Effect.fn('RepositoryWorktrees.requireGit')(function* (
  operation: RepositoryWorktreeError['operation'],
  arguments_: ReadonlyArray<string>,
) {
  const result = yield* runGit(arguments_)
  if (result.exitCode !== 0) {
    return yield* new RepositoryWorktreeError({
      operation,
      detail: result.stderr || result.stdout || `git ${arguments_.join(' ')} failed.`,
    })
  }
  return result.stdout
})

const directorySize = Effect.fn('RepositoryWorktrees.directorySize')(function* (directory: string) {
  const result = yield* Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(['du', '-sk', directory], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
    },
    catch: (cause) =>
      new RepositoryWorktreeError({
        operation: 'inspect',
        detail: `Failed to measure worktree '${directory}'.`,
        cause,
      }),
  })
  if (result.exitCode !== 0) {
    return yield* new RepositoryWorktreeError({
      operation: 'inspect',
      detail: result.stderr || `Could not measure worktree '${directory}'.`,
    })
  }
  const kibibytes = Number.parseInt(result.stdout.split(/\s+/u)[0] ?? '', 10)
  if (!Number.isFinite(kibibytes) || kibibytes < 0) {
    return yield* new RepositoryWorktreeError({
      operation: 'inspect',
      detail: `Could not decode the size of worktree '${directory}'.`,
    })
  }
  return kibibytes * 1_024
})

export const inspectRepositoryWorktree = Effect.fn('RepositoryWorktrees.inspectManaged')(function* (
  directory: string,
) {
  const path = resolve(directory)
  const inside = yield* runGit(['-C', path, 'rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0 || inside.stdout !== 'true') return null
  const [branch, head, commonDirectory, status, sizeBytes] = yield* Effect.all([
    requireGit('inspect', ['-C', path, 'branch', '--show-current']),
    requireGit('inspect', ['-C', path, 'rev-parse', 'HEAD']),
    requireGit('inspect', ['-C', path, 'rev-parse', '--git-common-dir']).pipe(
      Effect.map((value) => resolve(path, value)),
    ),
    requireGit('inspect', ['-C', path, 'status', '--porcelain=v1', '--untracked-files=all']),
    directorySize(path),
  ])
  return RepositoryWorktreeSnapshot.make({
    path,
    branch,
    head,
    commonDirectory,
    status,
    sizeBytes,
  })
})

/** One worktree registered with a Friday repository cache, from git's own registry. */
export const ManagedWorktreeListEntry = Schema.Struct({
  /** Remote URL of the repository cache the worktree was created from. */
  url: Schema.String,
  cachePath: Schema.String,
  /** Absolute worktree path as registered with git; may no longer exist on disk. */
  path: Schema.String,
  /** Branch without `refs/heads/`; `null` for a detached head. */
  branch: Schema.NullOr(Schema.String),
  head: Schema.String,
  /** True when git reports the worktree directory as missing (prunable). */
  prunable: Schema.Boolean,
})
export type ManagedWorktreeListEntry = typeof ManagedWorktreeListEntry.Type

interface WorktreeListRecord {
  path?: string
  head?: string
  branch?: string
  detached?: boolean
  bare?: boolean
  prunable?: boolean
}

const parseWorktreePorcelain = (output: string): ReadonlyArray<WorktreeListRecord> =>
  output.split('\n\n').map((record) => {
    const entry: WorktreeListRecord = {}
    for (const line of record.split('\n')) {
      const separator = line.indexOf(' ')
      const key = separator === -1 ? line : line.slice(0, separator)
      const value = separator === -1 ? undefined : line.slice(separator + 1)
      if (key === 'worktree' && value !== undefined) entry.path = value
      else if (key === 'HEAD' && value !== undefined) entry.head = value
      else if (key === 'branch' && value !== undefined) {
        entry.branch = value.replace(/^refs\/heads\//u, '')
      } else if (key === 'detached') entry.detached = true
      else if (key === 'bare') entry.bare = true
      else if (key === 'prunable') entry.prunable = true
    }
    return entry
  })

/**
 * Lists the repository worktrees registered with Friday's repository caches
 * under `$FRIDAY_HOME/repositories`. Discovery is read-only and grounded in
 * git's own worktree registry for the persisted caches; it never scans the
 * file system for arbitrary git repositories. Missing caches yield an empty
 * list instead of an error.
 */
export const listManagedWorktrees = Effect.fn('RepositoryWorktrees.listManaged')(function* () {
  const repositoryDirectory = join(FRIDAY_HOME, 'repositories')
  const caches = yield* Effect.tryPromise({
    try: async () => {
      // A missing cache directory simply means no worktrees were ever created.
      const entries = await readdir(repositoryDirectory, { withFileTypes: true }).catch(
        (cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return []
          throw cause
        },
      )
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.git'))
        .map((entry) => join(repositoryDirectory, entry.name))
        .toSorted()
    },
    catch: (cause) =>
      new RepositoryWorktreeError({
        operation: 'inspect',
        detail: `Could not read the repository cache directory '${repositoryDirectory}'.`,
        cause,
      }),
  })
  const listCacheWorktrees = Effect.fn('RepositoryWorktrees.listCache')(function* (
    cachePath: string,
  ) {
    const urlResult = yield* runGit([
      '--git-dir',
      cachePath,
      'config',
      '--get',
      'remote.origin.url',
    ])
    const url = urlResult.exitCode === 0 ? urlResult.stdout : cachePath
    const listing = yield* requireGit('inspect', [
      '--git-dir',
      cachePath,
      'worktree',
      'list',
      '--porcelain',
    ])
    return parseWorktreePorcelain(listing)
      .filter((record) => record.path !== undefined && !record.bare)
      .map((record): ManagedWorktreeListEntry =>
        ManagedWorktreeListEntry.make({
          url,
          cachePath,
          path: record.path!,
          branch: record.detached === true ? null : (record.branch ?? null),
          head: record.head ?? '',
          prunable: record.prunable === true,
        }),
      )
  })
  const entryGroups = yield* Effect.forEach(caches, listCacheWorktrees)
  return entryGroups.flat().toSorted((left, right) => left.path.localeCompare(right.path))
})

export const removeRepositoryWorktree = Effect.fn('RepositoryWorktrees.removeManaged')(function* (
  snapshot: RepositoryWorktreeSnapshot,
) {
  const current = yield* inspectRepositoryWorktree(snapshot.path)
  if (
    current === null ||
    current.head !== snapshot.head ||
    current.branch !== snapshot.branch ||
    current.status !== snapshot.status ||
    current.commonDirectory !== snapshot.commonDirectory
  ) {
    return yield* new RepositoryWorktreeError({
      operation: 'validate',
      detail: `Worktree '${snapshot.path}' changed after cleanup approval was requested.`,
    })
  }
  yield* requireGit('remove', [
    '--git-dir',
    snapshot.commonDirectory,
    'worktree',
    'remove',
    '--force',
    snapshot.path,
  ])
  if (snapshot.branch.startsWith('friday/task/')) {
    yield* requireGit('remove', [
      '--git-dir',
      snapshot.commonDirectory,
      'branch',
      '-D',
      snapshot.branch,
    ])
  }
  yield* requireGit('remove', ['--git-dir', snapshot.commonDirectory, 'worktree', 'prune'])
})

interface RepositoryLocation {
  readonly host: string
  readonly path: string
}

const splitRepository = (rawUrl: string): RepositoryLocation => {
  const url = rawUrl.trim().replace(/\/$/u, '')
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)\/(.+)$/iu.exec(url)
  if (schemeMatch) {
    return { host: schemeMatch[1]?.replace(/^.*@/u, '') ?? '', path: schemeMatch[2] ?? '' }
  }
  const scpMatch = /^(?:[^@]+@)?([^:]+):(.+)$/u.exec(url)
  if (scpMatch) return { host: scpMatch[1] ?? '', path: scpMatch[2] ?? '' }
  return { host: '', path: url }
}

const repositoryName = (url: string): string => {
  const { path } = splitRepository(url)
  const name = basename(path).replace(/\.git$/u, '')
  return name || 'repository'
}

const safeSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '+')
    .replace(/^\++|\++$/gu, '') || 'repository'

const cacheName = (url: string): string => {
  const { host, path } = splitRepository(url)
  const identity = safeSegment([host, path.replace(/\.git$/u, '')].filter(Boolean).join('+'))
  return `${identity}-${createHash('sha256').update(url).digest('hex').slice(0, 10)}.git`
}

const branchName = (workspaceRoot: string): string => {
  const workspace = safeSegment(basename(workspaceRoot)).slice(0, 32)
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 10)
  return `friday/${workspace}/${hash}`
}

const sameRemote = Effect.fn('RepositoryWorktrees.sameRemote')(function* (
  directory: string,
  requestedUrl: string,
) {
  const result = yield* runGit(['-C', directory, 'remote', 'get-url', 'origin'])
  return result.exitCode === 0 && result.stdout === requestedUrl
})

const resolveBaseRef = Effect.fn('RepositoryWorktrees.resolveBaseRef')(function* (
  cachePath: string,
  requestedRef?: string,
) {
  if (requestedRef) {
    for (const candidate of [requestedRef, `origin/${requestedRef}`]) {
      const result = yield* runGit(['--git-dir', cachePath, 'rev-parse', '--verify', candidate])
      if (result.exitCode === 0) return candidate
    }
    return yield* new RepositoryWorktreeError({
      operation: 'resolve-ref',
      detail: `Git ref '${requestedRef}' was not found in the repository cache.`,
    })
  }
  const symbolic = yield* runGit([
    '--git-dir',
    cachePath,
    'symbolic-ref',
    '--quiet',
    'refs/remotes/origin/HEAD',
  ])
  if (symbolic.exitCode === 0) return symbolic.stdout.replace(/^refs\//u, '')
  for (const candidate of ['origin/main', 'origin/master']) {
    const result = yield* runGit(['--git-dir', cachePath, 'rev-parse', '--verify', candidate])
    if (result.exitCode === 0) return candidate
  }
  return yield* new RepositoryWorktreeError({
    operation: 'resolve-ref',
    detail: 'Could not resolve the remote default branch.',
  })
})

export interface EnsureRepositoryWorktreeInput {
  readonly url: RepositoryUrl
  readonly workspaceRoot: string
  readonly ref?: string
}

export interface CreateIsolatedWorktreeInput {
  readonly primaryWorktree: string
  readonly taskId: string
}

export const createIsolatedWorktree = Effect.fn('RepositoryWorktrees.createIsolated')(function* (
  input: CreateIsolatedWorktreeInput,
) {
  const primary = resolve(input.primaryWorktree)
  const gitDirectory = yield* requireGit('inspect', [
    '-C',
    primary,
    'rev-parse',
    '--git-common-dir',
  ])
  const commonDirectory = resolve(primary, gitDirectory)
  const baseCommit = yield* requireGit('inspect', ['-C', primary, 'rev-parse', 'HEAD'])
  const shortTaskId = safeSegment(input.taskId.replace(/^task-/u, '')).slice(0, 12)
  const destination = `${primary}--${shortTaskId}`
  const branch = `friday/task/${shortTaskId}`
  const existing = yield* runGit(['-C', destination, 'rev-parse', '--is-inside-work-tree'])
  if (existing.exitCode === 0) {
    const currentBranch = yield* requireGit('inspect', [
      '-C',
      destination,
      'branch',
      '--show-current',
    ])
    return ManagedWorktree.make({
      url: RepositoryUrl.make(
        yield* requireGit('inspect', ['-C', primary, 'remote', 'get-url', 'origin']),
      ),
      path: destination,
      branch: currentBranch,
      baseRef: baseCommit,
      cachePath: commonDirectory,
      reused: true,
    })
  }
  if (yield* Effect.promise(() => Bun.file(destination).exists())) {
    return yield* new RepositoryWorktreeError({
      operation: 'validate',
      detail: `Isolated worktree destination '${destination}' already exists.`,
    })
  }
  yield* requireGit('create', [
    '-C',
    primary,
    'worktree',
    'add',
    '-b',
    branch,
    destination,
    baseCommit,
  ])
  return ManagedWorktree.make({
    url: RepositoryUrl.make(
      yield* requireGit('inspect', ['-C', primary, 'remote', 'get-url', 'origin']),
    ),
    path: destination,
    branch,
    baseRef: baseCommit,
    cachePath: commonDirectory,
    reused: false,
  })
})

export const ensureRepositoryWorktree = Effect.fn('RepositoryWorktrees.ensure')(function* (
  input: EnsureRepositoryWorktreeInput,
) {
  const workspaceRoot = resolve(input.workspaceRoot)
  const destination = join(workspaceRoot, repositoryName(input.url))
  const cachePath = join(FRIDAY_HOME, 'repositories', cacheName(input.url))
  const existing = yield* runGit(['-C', destination, 'rev-parse', '--is-inside-work-tree'])
  if (existing.exitCode === 0) {
    if (!(yield* sameRemote(destination, input.url))) {
      return yield* new RepositoryWorktreeError({
        operation: 'validate',
        detail: `Existing directory '${destination}' belongs to a different Git remote.`,
      })
    }
    const branch = yield* requireGit('inspect', ['-C', destination, 'branch', '--show-current'])
    const baseRef = yield* requireGit('inspect', ['-C', destination, 'rev-parse', 'HEAD'])
    return ManagedWorktree.make({
      url: input.url,
      path: destination,
      branch,
      baseRef,
      cachePath,
      reused: true,
    })
  }
  if (yield* Effect.promise(() => Bun.file(destination).exists())) {
    return yield* new RepositoryWorktreeError({
      operation: 'validate',
      detail: `Destination '${destination}' already exists and is not a Git worktree.`,
    })
  }

  yield* Effect.promise(() => Bun.$`mkdir -p ${join(FRIDAY_HOME, 'repositories')}`.quiet())
  const bare = yield* runGit(['--git-dir', cachePath, 'rev-parse', '--is-bare-repository'])
  if (bare.exitCode !== 0 || bare.stdout !== 'true') {
    yield* requireGit('clone', ['clone', '--bare', input.url, cachePath])
    yield* requireGit('clone', [
      '--git-dir',
      cachePath,
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    ])
  }
  const fetched = yield* runGit(['--git-dir', cachePath, 'fetch', 'origin'])
  if (fetched.exitCode !== 0) {
    yield* Effect.logWarning('repository.fetch.failed').pipe(
      Effect.annotateLogs({ url: input.url, cachePath, detail: fetched.stderr }),
    )
  }
  yield* runGit(['--git-dir', cachePath, 'remote', 'set-head', 'origin', '--auto'])
  const baseRef = yield* resolveBaseRef(cachePath, input.ref)
  const branch = branchName(workspaceRoot)
  const branchExists = yield* runGit([
    '--git-dir',
    cachePath,
    'show-ref',
    '--verify',
    `refs/heads/${branch}`,
  ])
  const arguments_ =
    branchExists.exitCode === 0
      ? ['--git-dir', cachePath, 'worktree', 'add', destination, branch]
      : ['--git-dir', cachePath, 'worktree', 'add', '-b', branch, destination, baseRef]
  yield* requireGit('create', arguments_)
  return ManagedWorktree.make({
    url: input.url,
    path: destination,
    branch,
    baseRef,
    cachePath,
    reused: false,
  })
})
