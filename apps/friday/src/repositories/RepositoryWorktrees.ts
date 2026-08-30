/* oxlint-disable effecttsgo/node-builtin-import -- Repository paths and stable hashes use Node's standard library. */

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { createHash } from 'node:crypto'
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

export class RepositoryWorktreeError extends Schema.Error<RepositoryWorktreeError>(
  'RepositoryWorktreeError',
)({
  _tag: Schema.tag('RepositoryWorktreeError'),
  operation: Schema.Literals(['inspect', 'clone', 'fetch', 'resolve-ref', 'create', 'validate']),
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
