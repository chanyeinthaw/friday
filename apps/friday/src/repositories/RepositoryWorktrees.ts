/* oxlint-disable effecttsgo/node-builtin-import -- Repository paths and stable hashes use Node's standard library (available under both Bun and vitest runtimes). */

import * as Effect from 'effect/Effect'
import * as DateTime from 'effect/DateTime'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { FRIDAY_HOME } from '../FridayHome.ts'
import { runProcess } from './RepositoryWorktreesProcess.ts'

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))
export const RepositoryUrl = NonEmptyString.pipe(Schema.brand('RepositoryUrl'))
export type RepositoryUrl = typeof RepositoryUrl.Type

export const ManagedWorktree = Schema.Struct({
  url: RepositoryUrl,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  commonDirectory: Schema.String,
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

/** Resolves `true` when any filesystem entry exists at the path. */
const pathExists = (path: string) =>
  Effect.promise(() =>
    stat(path)
      .then(() => true)
      .catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return false
        throw cause
      }),
  )

const runGit = Effect.fn('RepositoryWorktrees.git')(function* (arguments_: ReadonlyArray<string>) {
  return yield* runProcess(
    'git',
    arguments_,
    (cause) =>
      new RepositoryWorktreeError({
        operation: 'inspect',
        detail: `Failed to run git ${arguments_.join(' ')}.`,
        cause,
      }),
  )
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
  const result = yield* runProcess(
    'du',
    ['-sk', directory],
    (cause) =>
      new RepositoryWorktreeError({
        operation: 'inspect',
        detail: `Failed to measure worktree '${directory}'.`,
        cause,
      }),
  )
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

/**
 * One worktree registered with Friday, resolved against git's own worktree
 * registry at listing time. Entries come from Friday's persisted worktree
 * registry, never from a filesystem scan.
 */
export const ManagedWorktreeListEntry = Schema.Struct({
  /** Remote URL of the repository the worktree was created from. */
  url: Schema.String,
  /** Git common directory that owns the worktree registration. */
  commonDirectory: Schema.String,
  /** Absolute worktree path as registered with git; may no longer exist on disk. */
  path: Schema.String,
  /** Branch without `refs/heads/`; `null` for a detached head. */
  branch: Schema.NullOr(Schema.String),
  head: Schema.String,
  /** True when git reports the worktree directory as missing (prunable). */
  prunable: Schema.Boolean,
})
export type ManagedWorktreeListEntry = typeof ManagedWorktreeListEntry.Type

export interface WorktreeListRecord {
  path?: string
  head?: string
  branch?: string
  detached?: boolean
  bare?: boolean
  prunable?: boolean
}

/** Parses `git worktree list --porcelain` output into per-worktree records. */
export const parseWorktreePorcelain = (output: string): ReadonlyArray<WorktreeListRecord> =>
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
 * One entry of Friday's persisted worktree registry. The registry is written
 * only by Friday's own worktree lifecycle operations (ensure, isolated task
 * creation, removal), so every listed worktree is Friday-managed by
 * construction.
 */
export const ManagedWorktreeRegistration = Schema.Struct({
  /** Absolute worktree path as registered with git. */
  path: Schema.String,
  /** Remote URL Friday used when creating or adopting the worktree. */
  url: Schema.String,
  /** Git common directory that owns the worktree registration. */
  commonDirectory: Schema.String,
  /** ISO timestamp of the lifecycle operation that last registered the entry. */
  registeredAt: Schema.String,
})
export type ManagedWorktreeRegistration = typeof ManagedWorktreeRegistration.Type

const WorktreeRegistry = Schema.Struct({
  version: Schema.Literal(1),
  worktrees: Schema.Array(ManagedWorktreeRegistration),
})
export type WorktreeRegistry = typeof WorktreeRegistry.Type

const decodeRegistry = Schema.decodeUnknownEffect(Schema.fromJsonString(WorktreeRegistry))

export const worktreeRegistryPath = (home: string = FRIDAY_HOME): string =>
  join(home, 'repositories', 'worktrees.json')

/**
 * Reads the persisted worktree registry. Returns `null` when no registry file
 * exists yet (the pre-registry migration case); a malformed registry is a
 * typed error rather than silently discarded state.
 */
export const readWorktreeRegistry = (
  home: string = FRIDAY_HOME,
): Effect.Effect<WorktreeRegistry | null, RepositoryWorktreeError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () =>
        readFile(worktreeRegistryPath(home), 'utf8').catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return null
          throw cause
        }),
      catch: (cause) =>
        new RepositoryWorktreeError({
          operation: 'inspect',
          detail: 'Could not read the managed worktree registry.',
          cause,
        }),
    })
    if (text === null) return null
    return yield* decodeRegistry(text).pipe(
      Effect.mapError(
        (cause) =>
          new RepositoryWorktreeError({
            operation: 'inspect',
            detail: `The managed worktree registry '${worktreeRegistryPath(home)}' is invalid.`,
            cause,
          }),
      ),
    )
  })

/** Returns whether the exact path is owned by Friday's managed-worktree registry. */
export const isManagedWorktree = Effect.fn('RepositoryWorktrees.isManaged')(function* (
  path: string,
  home: string = FRIDAY_HOME,
) {
  const registry = yield* readWorktreeRegistry(home)
  const resolvedPath = resolve(path)
  return registry?.worktrees.some((entry) => resolve(entry.path) === resolvedPath) ?? false
})

// Stryker disable all: The lock protocol is exercised by separate-process integration tests, which Stryker cannot run in its vitest sandbox.
const registrySemaphore = Semaphore.makeUnsafe(1)

export interface RegistryLockOptions {
  readonly timeoutMs?: number
  readonly retryMs?: number
}

const defaultRegistryLockTimeoutMs = 10_000
const defaultRegistryLockRetryMs = 25

export const registryLockPath = (home: string): string => `${worktreeRegistryPath(home)}.lock`

const RegistryLockOwner = Schema.Struct({
  token: Schema.String,
  pid: Schema.Int,
  startedAt: Schema.String,
  processStartId: Schema.NullOr(Schema.String),
})
type RegistryLockOwner = typeof RegistryLockOwner.Type

const decodeRegistryLockOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(RegistryLockOwner))
const encodeRegistryLockOwner = Schema.encodeSync(Schema.fromJsonString(RegistryLockOwner))

interface RegistryLockHolder {
  readonly lockPath: string
  readonly ownerPath: string
  readonly owner: RegistryLockOwner
}

const pause = (milliseconds: number) =>
  Effect.promise(() => new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds)))

const processStartId = async (pid: number): Promise<string | null> => {
  if (process.platform !== 'linux') return null
  return readFile(`/proc/${pid}/stat`, 'utf8').then(
    (value) => value.slice(value.lastIndexOf(') ') + 2).split(' ')[19] ?? null,
    () => null,
  )
}

/** Returns false only when the recorded process can be proven dead or reused. */
const registryLockOwnerIsLive = (owner: RegistryLockOwner) =>
  Effect.promise(async () => {
    try {
      process.kill(owner.pid, 0)
    } catch (cause) {
      // SAFETY: Node process errors expose the optional errno `code` field.
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      return true
    }
    if (owner.processStartId === null) return true
    const currentStartId = await processStartId(owner.pid)
    return currentStartId === null || currentStartId === owner.processStartId
  })

const removeEmptyLockDirectory = (lockPath: string) =>
  Effect.promise(() =>
    rmdir(lockPath).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'ENOENT' && cause.code !== 'ENOTEMPTY' && cause.code !== 'EEXIST')
        throw cause
    }),
  )

/**
 * Moves a proven-dead owner's token out of the lock directory before removing
 * the directory. A successor cannot acquire until that directory is gone, so
 * the recovery path cannot delete a successor's lock.
 */
const reclaimDeadRegistryLockOwner = Effect.fn('RepositoryWorktrees.reclaimDeadLock')(function* (
  lockPath: string,
  ownerPath: string,
  owner: RegistryLockOwner,
) {
  if (yield* registryLockOwnerIsLive(owner)) return
  const quarantinePath = `${lockPath}.reclaim-${owner.token}`
  const moved = yield* Effect.promise(() =>
    rename(ownerPath, quarantinePath).then(
      () => true,
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return false
        throw cause
      },
    ),
  )
  if (!moved) return
  yield* removeEmptyLockDirectory(lockPath)
  yield* Effect.promise(() => rm(quarantinePath, { force: true }))
})

/**
 * Acquires a lock-directory token shared by all Friday processes. Contention
 * waits and retries. Recovery only moves an owner's matching token after its
 * PID is proven dead, or its Linux process start id proves PID reuse. Age is
 * recorded for diagnosis but never decides liveness.
 */
export const acquireRegistryLock = Effect.fn('RepositoryWorktrees.acquireRegistryLock')(function* (
  home: string,
  options: RegistryLockOptions = {},
) {
  const lockPath = registryLockPath(home)
  const waitingSince = Date.now()
  const timeoutMs = options.timeoutMs ?? defaultRegistryLockTimeoutMs
  const retryMs = options.retryMs ?? defaultRegistryLockRetryMs
  const owner = RegistryLockOwner.make({
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
    processStartId: yield* Effect.promise(() => processStartId(process.pid)),
  })
  const ownerPath = join(lockPath, `owner-${owner.token}.json`)
  const claimantPath = `${lockPath}.claim-${owner.token}.json`
  yield* Effect.tryPromise({
    try: () => mkdir(dirname(lockPath), { recursive: true }),
    catch: (cause) =>
      new RepositoryWorktreeError({
        operation: 'inspect',
        detail: 'Could not create the managed worktree registry directory.',
        cause,
      }),
  })
  yield* Effect.tryPromise({
    try: () =>
      writeFile(claimantPath, encodeRegistryLockOwner(owner), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      }),
    catch: (cause) =>
      new RepositoryWorktreeError({
        operation: 'inspect',
        detail: 'Could not create the managed worktree registry lock token.',
        cause,
      }),
  })

  while (Date.now() - waitingSince < timeoutMs) {
    const acquired = yield* Effect.tryPromise({
      try: async () => {
        const created = await mkdir(lockPath).then(
          () => true,
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === 'EEXIST') return false
            throw cause
          },
        )
        if (!created) return false
        await rename(claimantPath, ownerPath)
        return true
      },
      catch: (cause) =>
        new RepositoryWorktreeError({
          operation: 'inspect',
          detail: 'Could not acquire the managed worktree registry lock.',
          cause,
        }),
    })
    if (acquired) return { lockPath, ownerPath, owner } satisfies RegistryLockHolder

    const ownerFiles = yield* Effect.promise(() =>
      readdir(lockPath).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return []
        throw cause
      }),
    )
    if (ownerFiles.length === 0) {
      yield* removeEmptyLockDirectory(lockPath)
    } else {
      for (const ownerFile of ownerFiles) {
        if (!ownerFile.startsWith('owner-') || !ownerFile.endsWith('.json')) continue
        const existingOwnerPath = join(lockPath, ownerFile)
        const existingOwner = yield* Effect.promise(() =>
          readFile(existingOwnerPath, 'utf8').then(
            (text) => text,
            (cause: NodeJS.ErrnoException) => {
              if (cause.code === 'ENOENT') return null
              throw cause
            },
          ),
        ).pipe(
          Effect.flatMap((text) =>
            text === null
              ? Effect.succeed(null)
              : decodeRegistryLockOwner(text).pipe(Effect.orElseSucceed(() => null)),
          ),
        )
        if (existingOwner !== null) {
          yield* reclaimDeadRegistryLockOwner(lockPath, existingOwnerPath, existingOwner)
        }
      }
    }
    yield* pause(retryMs)
  }
  yield* Effect.promise(() => rm(claimantPath, { force: true }))
  return yield* new RepositoryWorktreeError({
    operation: 'inspect',
    detail: 'Timed out waiting for the managed worktree registry lock.',
  })
})

export const releaseRegistryLock = Effect.fn('RepositoryWorktrees.releaseRegistryLock')(function* (
  holder: RegistryLockHolder,
) {
  const onDisk = yield* Effect.promise(() =>
    readFile(holder.ownerPath, 'utf8').then(
      (text) => text,
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return null
        throw cause
      },
    ),
  )
  if (onDisk === null) return
  const owner = yield* decodeRegistryLockOwner(onDisk).pipe(Effect.orElseSucceed(() => null))
  if (owner === null || owner.token !== holder.owner.token) return
  const quarantinePath = `${holder.lockPath}.release-${holder.owner.token}`
  const moved = yield* Effect.promise(() =>
    rename(holder.ownerPath, quarantinePath).then(
      () => true,
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return false
        throw cause
      },
    ),
  )
  if (!moved) return
  yield* removeEmptyLockDirectory(holder.lockPath)
  yield* Effect.promise(() => rm(quarantinePath, { force: true }))
})

// Stryker restore all

/** Writes a complete registry by atomic rename, so readers never see a partial document. */
const writeRegistry = (home: string, registry: WorktreeRegistry) =>
  Effect.acquireUseRelease(
    Effect.sync(() => `${worktreeRegistryPath(home)}.${randomUUID()}.tmp`),
    (temporaryPath) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(worktreeRegistryPath(home)), { recursive: true })
          const ordered: WorktreeRegistry = {
            version: 1,
            worktrees: registry.worktrees.toSorted((left, right) =>
              left.path.localeCompare(right.path),
            ),
          }
          await writeFile(temporaryPath, `${JSON.stringify(ordered, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          })
          await rename(temporaryPath, worktreeRegistryPath(home))
        },
        catch: (cause) =>
          new RepositoryWorktreeError({
            operation: 'inspect',
            detail: 'Could not write the managed worktree registry.',
            cause,
          }),
      }),
    (temporaryPath) => Effect.promise(() => rm(temporaryPath, { force: true })),
  )

/** Serializes registry read-modify-write operations within and across Friday processes. */
const updateRegistry = (
  home: string,
  update: (entries: ReadonlyArray<ManagedWorktreeRegistration>) => WorktreeRegistry,
) =>
  registrySemaphore.withPermit(
    Effect.acquireUseRelease(
      acquireRegistryLock(home),
      () =>
        Effect.gen(function* () {
          const existing = yield* readWorktreeRegistry(home)
          yield* writeRegistry(home, update(existing?.worktrees ?? []))
        }),
      releaseRegistryLock,
    ),
  )

/** Adds or refreshes one registry entry. A missing registry starts empty. */
const registerManagedWorktree = Effect.fn('RepositoryWorktrees.register')(function* (
  home: string,
  registration: ManagedWorktreeRegistration,
) {
  yield* updateRegistry(home, (entries) => ({
    version: 1,
    worktrees: [...entries.filter((entry) => entry.path !== registration.path), registration],
  }))
})

/** Removes one registry entry; a missing registry is materialized as empty. */
export const unregisterManagedWorktree = Effect.fn('RepositoryWorktrees.unregister')(function* (
  home: string,
  path: string,
) {
  yield* updateRegistry(home, (entries) => ({
    version: 1,
    worktrees: entries.filter((entry) => entry.path !== path),
  }))
})

const missingWorktreeEntry = (
  registration: ManagedWorktreeRegistration,
): ManagedWorktreeListEntry =>
  ManagedWorktreeListEntry.make({
    url: registration.url,
    commonDirectory: registration.commonDirectory,
    path: registration.path,
    branch: null,
    head: '',
    prunable: true,
  })

/**
 * Lists the repository worktrees Friday manages. The persisted registry is the
 * source of truth for which worktrees are Friday-managed; git's own worktree
 * registry (queried at each entry's common directory) supplies the current
 * branch, head, and prunable state. Discovery never scans the file system for
 * arbitrary git repositories. A missing registry means that no worktree can
 * yet be proven Friday-owned, so pre-registry worktrees stay unlisted until a
 * Friday lifecycle operation registers them.
 */
export const listManagedWorktrees = Effect.fn('RepositoryWorktrees.listManaged')(function* (
  home: string = FRIDAY_HOME,
) {
  const existing = yield* readWorktreeRegistry(home)
  const registrations = existing?.worktrees ?? []
  const entries = yield* Effect.forEach(registrations, (registration) =>
    Effect.gen(function* () {
      const listing = yield* runGit([
        '--git-dir',
        registration.commonDirectory,
        'worktree',
        'list',
        '--porcelain',
      ])
      if (listing.exitCode !== 0) {
        // The owning repository is gone or unreadable; the registry entry is
        // the only remaining evidence, so surface it as missing on disk.
        return missingWorktreeEntry(registration)
      }
      const record = parseWorktreePorcelain(listing.stdout).find(
        (candidate) => candidate.path === registration.path,
      )
      if (record === undefined || record.path === undefined) {
        return missingWorktreeEntry(registration)
      }
      return ManagedWorktreeListEntry.make({
        url: registration.url,
        commonDirectory: registration.commonDirectory,
        path: record.path,
        branch: record.detached === true ? null : (record.branch ?? null),
        head: record.head ?? '',
        prunable: record.prunable === true,
      })
    }),
  )
  return entries.flat().toSorted((left, right) => left.path.localeCompare(right.path))
})

export const validateRepositoryWorktreeSnapshot = Effect.fn('RepositoryWorktrees.validateSnapshot')(
  function* (snapshot: RepositoryWorktreeSnapshot) {
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
  },
)

const validateMissingTaskBranchOwnership = Effect.fn(
  'RepositoryWorktrees.validateMissingTaskBranchOwnership',
)(function* (snapshot: RepositoryWorktreeSnapshot) {
  const branchRef = `refs/heads/${snapshot.branch}`
  const branch = yield* runGit([
    '--git-dir',
    snapshot.commonDirectory,
    'show-ref',
    '--hash',
    '--verify',
    branchRef,
  ])
  if (branch.exitCode !== 0) return false
  if (branch.stdout !== snapshot.head) {
    return yield* new RepositoryWorktreeError({
      operation: 'validate',
      detail: `Worktree '${snapshot.path}' changed after cleanup approval was requested.`,
    })
  }

  const listing = yield* requireGit('validate', [
    '--git-dir',
    snapshot.commonDirectory,
    'worktree',
    'list',
    '--porcelain',
  ])
  const branchHasSuccessor = parseWorktreePorcelain(listing).some(
    (record) => record.path !== snapshot.path && record.branch === snapshot.branch,
  )
  if (branchHasSuccessor) {
    return yield* new RepositoryWorktreeError({
      operation: 'validate',
      detail: `Worktree '${snapshot.path}' changed after cleanup approval was requested.`,
    })
  }
  return true
})

export const removeRepositoryWorktree = Effect.fn('RepositoryWorktrees.removeManaged')(function* (
  snapshot: RepositoryWorktreeSnapshot,
  home: string = FRIDAY_HOME,
) {
  const current = yield* inspectRepositoryWorktree(snapshot.path)
  if (current !== null) {
    yield* validateRepositoryWorktreeSnapshot(snapshot)
    yield* requireGit('remove', [
      '--git-dir',
      snapshot.commonDirectory,
      'worktree',
      'remove',
      '--force',
      snapshot.path,
    ])
  }
  if (snapshot.branch.startsWith('friday/task/')) {
    const mayDeleteBranch =
      current === null ? yield* validateMissingTaskBranchOwnership(snapshot) : true
    if (mayDeleteBranch) {
      const branch = yield* runGit([
        '--git-dir',
        snapshot.commonDirectory,
        'show-ref',
        '--verify',
        `refs/heads/${snapshot.branch}`,
      ])
      if (branch.exitCode === 0) {
        yield* requireGit('remove', [
          '--git-dir',
          snapshot.commonDirectory,
          'branch',
          '-D',
          snapshot.branch,
        ])
      }
    }
  }
  yield* requireGit('remove', ['--git-dir', snapshot.commonDirectory, 'worktree', 'prune'])
  // Retrying after a registry failure is safe: Git removal, branch deletion,
  // pruning, and unregistration are all checked or idempotent.
  yield* unregisterManagedWorktree(home, snapshot.path)
})

export interface RepositoryLocation {
  readonly host: string
  readonly path: string
}

/**
 * Splits a repository URL into its host and path, handling `scheme://`,
 * `user@host:path`, and plain local paths. Used for deterministic cache and
 * worktree naming.
 */
export const splitRepositoryLocation = (rawUrl: string): RepositoryLocation => {
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
  const { path } = splitRepositoryLocation(url)
  const name = basename(path).replace(/\.git$/u, '')
  return name || 'repository'
}

const safeSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '+')
    .replace(/^\++|\++$/gu, '') || 'repository'

const cacheName = (url: string): string => {
  const { host, path } = splitRepositoryLocation(url)
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

const registrationWithRollback = (
  registration: Effect.Effect<void, RepositoryWorktreeError>,
  rollback: Effect.Effect<void, RepositoryWorktreeError>,
): Effect.Effect<void, RepositoryWorktreeError> =>
  registration.pipe(
    Effect.catch((original) =>
      rollback.pipe(
        Effect.catch((cleanup) =>
          Effect.fail(
            new RepositoryWorktreeError({
              operation: original.operation,
              detail: `${original.message} Rollback also failed: ${cleanup.message}`,
              cause: original,
            }),
          ),
        ),
        Effect.andThen(Effect.fail(original)),
      ),
    ),
  )

const rollbackCreatedWorktree = Effect.fn('RepositoryWorktrees.rollbackCreated')(function* (
  commonDirectory: string,
  destination: string,
  branch: string,
  deleteBranch: boolean,
) {
  const removed = yield* runGit([
    '--git-dir',
    commonDirectory,
    'worktree',
    'remove',
    '--force',
    destination,
  ])
  if (removed.exitCode !== 0 && (yield* pathExists(destination))) {
    return yield* new RepositoryWorktreeError({
      operation: 'remove',
      detail: removed.stderr || `Could not roll back worktree '${destination}'.`,
    })
  }
  if (deleteBranch) {
    const branchExists = yield* runGit([
      '--git-dir',
      commonDirectory,
      'show-ref',
      '--verify',
      `refs/heads/${branch}`,
    ])
    if (branchExists.exitCode === 0) {
      yield* requireGit('remove', ['--git-dir', commonDirectory, 'branch', '-D', branch])
    }
  }
  yield* requireGit('remove', ['--git-dir', commonDirectory, 'worktree', 'prune'])
})

export const createIsolatedWorktree = Effect.fn('RepositoryWorktrees.createIsolated')(function* (
  input: CreateIsolatedWorktreeInput,
  home: string = FRIDAY_HOME,
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
  const registeredAt = DateTime.formatIso(yield* DateTime.now)
  const origin = yield* requireGit('inspect', ['-C', primary, 'remote', 'get-url', 'origin'])
  const existing = yield* runGit(['-C', destination, 'rev-parse', '--is-inside-work-tree'])
  if (existing.exitCode === 0) {
    const [currentBranch, destinationGitDirectory] = yield* Effect.all([
      requireGit('inspect', ['-C', destination, 'branch', '--show-current']),
      requireGit('inspect', ['-C', destination, 'rev-parse', '--git-common-dir']),
    ])
    const destinationCommonDirectory = resolve(destination, destinationGitDirectory)
    const registered = yield* runGit([
      '--git-dir',
      commonDirectory,
      'worktree',
      'list',
      '--porcelain',
    ])
    const isRegistered =
      registered.exitCode === 0 &&
      parseWorktreePorcelain(registered.stdout).some((record) => record.path === destination)
    if (
      destinationCommonDirectory !== commonDirectory ||
      !isRegistered ||
      currentBranch !== branch
    ) {
      return yield* new RepositoryWorktreeError({
        operation: 'validate',
        detail: `Existing isolated destination '${destination}' is not the registered '${branch}' worktree of '${commonDirectory}'.`,
      })
    }
    yield* registerManagedWorktree(home, {
      path: destination,
      url: origin,
      commonDirectory,
      registeredAt,
    })
    return ManagedWorktree.make({
      url: RepositoryUrl.make(origin),
      path: destination,
      branch,
      baseRef: baseCommit,
      commonDirectory,
      reused: true,
    })
  }
  if (yield* pathExists(destination)) {
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
  yield* registrationWithRollback(
    registerManagedWorktree(home, {
      path: destination,
      url: origin,
      commonDirectory,
      registeredAt,
    }),
    rollbackCreatedWorktree(commonDirectory, destination, branch, true),
  )
  return ManagedWorktree.make({
    url: RepositoryUrl.make(
      yield* requireGit('inspect', ['-C', primary, 'remote', 'get-url', 'origin']),
    ),
    path: destination,
    branch,
    baseRef: baseCommit,
    commonDirectory,
    reused: false,
  })
})

export const ensureRepositoryWorktree = Effect.fn('RepositoryWorktrees.ensure')(function* (
  input: EnsureRepositoryWorktreeInput,
  home: string = FRIDAY_HOME,
) {
  const workspaceRoot = resolve(input.workspaceRoot)
  const destination = join(workspaceRoot, repositoryName(input.url))
  const cacheDirectory = join(home, 'repositories', cacheName(input.url))
  const registeredAt = DateTime.formatIso(yield* DateTime.now)
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
    const gitDirectory = yield* requireGit('inspect', [
      '-C',
      destination,
      'rev-parse',
      '--git-common-dir',
    ])
    const commonDirectory = resolve(destination, gitDirectory)
    yield* registerManagedWorktree(home, {
      path: destination,
      url: input.url,
      commonDirectory,
      registeredAt,
    })
    return ManagedWorktree.make({
      url: input.url,
      path: destination,
      branch,
      baseRef,
      commonDirectory,
      reused: true,
    })
  }
  if (yield* pathExists(destination)) {
    return yield* new RepositoryWorktreeError({
      operation: 'validate',
      detail: `Destination '${destination}' already exists and is not a Git worktree.`,
    })
  }

  yield* Effect.tryPromise({
    try: () => mkdir(join(home, 'repositories'), { recursive: true }),
    catch: (cause) =>
      new RepositoryWorktreeError({
        operation: 'create',
        detail: `Could not create the repository cache directory '${join(home, 'repositories')}'.`,
        cause,
      }),
  })
  const bare = yield* runGit(['--git-dir', cacheDirectory, 'rev-parse', '--is-bare-repository'])
  if (bare.exitCode !== 0 || bare.stdout !== 'true') {
    yield* requireGit('clone', ['clone', '--bare', input.url, cacheDirectory])
    yield* requireGit('clone', [
      '--git-dir',
      cacheDirectory,
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    ])
  }
  const fetched = yield* runGit(['--git-dir', cacheDirectory, 'fetch', 'origin'])
  if (fetched.exitCode !== 0) {
    yield* Effect.logWarning('repository.fetch.failed').pipe(
      Effect.annotateLogs({ url: input.url, cachePath: cacheDirectory, detail: fetched.stderr }),
    )
  }
  yield* runGit(['--git-dir', cacheDirectory, 'remote', 'set-head', 'origin', '--auto'])
  const baseRef = yield* resolveBaseRef(cacheDirectory, input.ref)
  const branch = branchName(workspaceRoot)
  const branchExists = yield* runGit([
    '--git-dir',
    cacheDirectory,
    'show-ref',
    '--verify',
    `refs/heads/${branch}`,
  ])
  const arguments_ =
    branchExists.exitCode === 0
      ? ['--git-dir', cacheDirectory, 'worktree', 'add', destination, branch]
      : ['--git-dir', cacheDirectory, 'worktree', 'add', '-b', branch, destination, baseRef]
  yield* requireGit('create', arguments_)
  yield* registrationWithRollback(
    registerManagedWorktree(home, {
      path: destination,
      url: input.url,
      commonDirectory: cacheDirectory,
      registeredAt,
    }),
    rollbackCreatedWorktree(cacheDirectory, destination, branch, branchExists.exitCode !== 0),
  )
  return ManagedWorktree.make({
    url: input.url,
    path: destination,
    branch,
    baseRef,
    commonDirectory: cacheDirectory,
    reused: false,
  })
})
