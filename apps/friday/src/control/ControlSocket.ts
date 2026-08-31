/* oxlint-disable effecttsgo/node-builtin-import -- The control socket uses Node net and fs, which run under both the Bun application runtime and the Node test runtime. */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import { dirname } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import { ConfigReloadOutcome, reloadFailed } from '../config/ConfigReload.ts'

/** One operation the running Friday process serves over its local control socket. */
export const ControlRequest = Schema.Union([Schema.Struct({ op: Schema.Literal('config.reload') })])
export type ControlRequest = typeof ControlRequest.Type

const encodeControlRequestValue = Schema.encodeSync(ControlRequest)
const decodeRequestLine = Schema.decodeUnknownEffect(Schema.fromJsonString(ControlRequest))
const decodeOutcomeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigReloadOutcome))
const encodeOutcomeValue = Schema.encodeSync(ConfigReloadOutcome)

export const encodeControlRequest = (request: ControlRequest): string =>
  `${JSON.stringify(encodeControlRequestValue(request))}\n`

const encodeOutcomeLine = (outcome: ConfigReloadOutcome): string =>
  `${JSON.stringify(encodeOutcomeValue(outcome))}\n`

export class ControlSocketError extends Schema.Error<ControlSocketError>('ControlSocketError')({
  _tag: Schema.tag('ControlSocketError'),
  operation: Schema.Literals([
    'listen',
    'stale-socket',
    'already-running',
    'connect',
    'request',
    'response-timeout',
    'response-oversized',
  ]),
  path: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Friday control socket ${this.operation} failed at ${this.path}: ${this.detail}`
  }
}

export interface ControlSocketServerContract {
  readonly path: string
}

export interface ControlSocketServerOptions {
  readonly path: string
  /** The shared reload operation served for `config.reload` requests. */
  readonly reload: Effect.Effect<ConfigReloadOutcome>
  /** Destroys clients that send more than this many bytes without a full request. */
  readonly requestByteLimit?: number
  /** Destroys clients that idle or stall (incomplete request) for this long. */
  readonly connectionTimeoutMs?: number
}

const DEFAULT_REQUEST_BYTE_LIMIT = 4096
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000

interface ConnectionLimits {
  readonly requestByteLimit: number
  readonly connectionTimeoutMs: number
}

/** Reads an errno-style `code` field off an unknown Node.js error. */
const ErrnoCode = Schema.Struct({ code: Schema.String })
const decodeErrnoCode = Schema.decodeUnknownOption(ErrnoCode)
const isErrno = (cause: unknown, code: string): boolean =>
  Option.getOrElse(
    Option.map(decodeErrnoCode(cause), (decoded) => decoded.code === code),
    () => false,
  )

/** One request per connection: a JSON line in, a JSON line out. */
const serveConnection = (
  connection: net.Socket,
  respond: (line: string) => Promise<string>,
  limits: ConnectionLimits,
  liveConnections: Set<net.Socket>,
): void => {
  liveConnections.add(connection)
  connection.on('close', () => {
    liveConnections.delete(connection)
  })
  let buffered = ''
  let received = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => connection.destroy(), limits.connectionTimeoutMs)
  }
  const stopIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
  }
  armIdleTimer()
  connection.on('data', (chunk) => {
    armIdleTimer()
    buffered += String(chunk)
    // Oversized clients are destroyed instead of buffered without bound.
    if (buffered.length > limits.requestByteLimit) {
      connection.destroy()
      return
    }
    const newline = buffered.indexOf('\n')
    if (newline === -1) return
    // Exactly one request per connection: a second line or trailing bytes after
    // the first request is a protocol violation, so drop the client.
    if (received || buffered.slice(newline + 1).trim().length > 0) {
      connection.destroy()
      return
    }
    received = true
    const line = buffered.slice(0, newline)
    void respond(line)
      .then((response) => {
        stopIdleTimer()
        connection.end(response)
      })
      .catch(() => {
        stopIdleTimer()
        connection.destroy()
      })
  })
  connection.on('error', () => {
    stopIdleTimer()
    connection.destroy()
  })
  connection.on('close', stopIdleTimer)
}

/**
 * Binds the Unix socket while the process umask is temporarily restricted, so
 * the socket file is owner-only from creation. The umask is restored as soon
 * as the bind completes (or fails); this single startup path is the only code
 * running file creation during that window.
 */
const listen = (
  path: string,
  respond: (line: string) => Promise<string>,
  limits: ConnectionLimits,
  liveConnections: Set<net.Socket>,
): Effect.Effect<net.Server, ControlSocketError> =>
  Effect.callback((resume) => {
    const previousUmask = process.umask(0o077)
    // Idempotent independently of the outcome: exactly one restore happens for
    // a successful bind, a failed bind, or an interruption, never zero.
    let umaskRestored = false
    const restoreUmask = () => {
      if (umaskRestored) return
      umaskRestored = true
      process.umask(previousUmask)
    }
    const server = net.createServer((connection) => {
      serveConnection(connection, respond, limits, liveConnections)
    })
    const fail = (cause: Error) => {
      restoreUmask()
      server.close()
      resume(
        Effect.fail(
          new ControlSocketError({
            operation: 'listen',
            path,
            detail: 'Could not bind the Friday control socket.',
            cause,
          }),
        ),
      )
    }
    server.once('error', fail)
    server.listen(path, () => {
      restoreUmask()
      server.removeListener('error', fail)
      resume(Effect.succeed(server))
    })
    return Effect.sync(() => {
      restoreUmask()
      server.close()
    })
  })

/** One-shot probe: does some live process accept connections on this socket? */
const socketIsAlive = (path: string): Effect.Effect<boolean> =>
  Effect.callback((resume) => {
    const probe = net.connect({ path })
    const settle = (alive: boolean) => {
      probe.destroy()
      resume(Effect.succeed(alive))
    }
    probe.once('connect', () => settle(true))
    probe.once('error', () => settle(false))
    return Effect.void
  })

const statIsSocket = (path: string) =>
  Effect.tryPromise({
    try: async (): Promise<boolean> => (await fs.stat(path)).isSocket(),
    catch: (cause) =>
      new ControlSocketError({
        operation: 'stale-socket',
        path,
        detail: 'Could not inspect the existing control socket.',
        cause,
      }),
  }).pipe(Effect.catch(() => Effect.succeed(false)))

const removeSocket = (path: string) =>
  Effect.tryPromise({
    try: () => fs.unlink(path),
    catch: (cause) =>
      new ControlSocketError({
        operation: 'stale-socket',
        path,
        detail: 'Could not remove the stale control socket.',
        cause,
      }),
  })

/**
 * The socket directory must be owner-only so no other local user can reach the
 * socket or race the restrictive bind. Creates the directory when missing.
 */
const ensureOwnerOnlyDirectory = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const directory = dirname(path)
      await fs.mkdir(directory, { recursive: true })
      await fs.chmod(directory, 0o700)
    },
    catch: (cause) =>
      new ControlSocketError({
        operation: 'listen',
        path,
        detail: 'Could not restrict the control socket directory to the owning user.',
        cause,
      }),
  })

const lockDirectoryFor = (socketPath: string): string => `${socketPath}.lock`
const lockOwnerFileFor = (lockPath: string): string => `${lockPath}/owner.json`

/**
 * Ownership record of the lifecycle lock. The Linux process start identity
 * (field 22 of `/proc/<pid>/stat`) distinguishes a recycled PID from the
 * original owner during liveness checks, and the random token is the only
 * proof that permits removing the lock during cleanup.
 */
const LockOwner = Schema.Struct({
  pid: Schema.Int,
  startTime: Schema.optional(Schema.String),
  token: Schema.String,
})
type LockOwner = typeof LockOwner.Type

const encodeLockOwner = Schema.encodeSync(LockOwner)
const decodeLockOwner = Schema.decodeUnknownOption(Schema.fromJsonString(LockOwner))

const isValidOwner = (owner: LockOwner): boolean => owner.pid > 0 && owner.token.length > 0

/**
 * Linux process start identity (field 22 of `/proc/<pid>/stat`, counted after
 * the pid/comm/state prefix); undefined whenever it cannot be read, including
 * on non-Linux platforms where the conservative fallback applies.
 */
const processStartTime = (pid: number): Promise<string | undefined> =>
  fs
    .readFile(`/proc/${pid}/stat`, 'utf8')
    .then((raw) => {
      // comm (field 2) may contain spaces and parentheses; numbered fields
      // resume after the final ')' with state (field 3) first.
      const afterComm = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
      const startTime = afterComm[19]
      return startTime === undefined || startTime === '' ? undefined : startTime
    })
    .catch(() => undefined)

/** Start identity of this process, read once; undefined off Linux. */
const selfStartTime = processStartTime(process.pid)

type LockAttempt =
  | { readonly kind: 'acquired'; readonly token: string }
  | { readonly kind: 'already-held' }
  | { readonly kind: 'failed'; readonly cause: unknown }

/** mkdir is atomic: exactly one concurrent starter can create the lock directory. */
const attemptLock = (socketPath: string): Effect.Effect<LockAttempt> =>
  Effect.promise(() =>
    selfStartTime.then((startTime) => {
      const lockPath = lockDirectoryFor(socketPath)
      const owner: LockOwner = { pid: process.pid, startTime, token: randomUUID() }
      const encoded = `${JSON.stringify(encodeLockOwner(owner))}\n`
      return fs.mkdir(lockPath, { mode: 0o700 }).then(
        () =>
          fs.writeFile(lockOwnerFileFor(lockPath), encoded, { mode: 0o600 }).then(
            (): LockAttempt => ({ kind: 'acquired', token: owner.token }),
            (cause: unknown) =>
              // The directory is ours but the ownership record is missing:
              // release it so this failure cannot wedge later starts.
              fs
                .rm(lockPath, { recursive: true, force: true })
                .catch(() => undefined)
                .then((): LockAttempt => ({ kind: 'failed', cause })),
          ),
        (cause: unknown): LockAttempt =>
          isErrno(cause, 'EEXIST') ? { kind: 'already-held' } : { kind: 'failed', cause },
      )
    }),
  )

/** The parsed ownership record, or none for a missing, corrupt, or invalid file. */
const readLockOwner = (lockPath: string): Effect.Effect<Option.Option<LockOwner>> =>
  Effect.promise(() =>
    fs
      .readFile(lockOwnerFileFor(lockPath), 'utf8')
      .then((raw) => {
        const decoded = decodeLockOwner(raw)
        return Option.isSome(decoded) && isValidOwner(decoded.value) ? decoded : Option.none()
      })
      .catch(() => Option.none()),
  )

/**
 * A lock without a readable owner is only stale once it has aged: a fresh
 * ownerless lock means a concurrent starter is between creating the lock
 * directory and recording its ownership, so it must not be stolen.
 */
const STALE_LOCK_AGE_MS = 10_000

const lockIsStaleAge = (lockPath: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    fs
      .stat(lockPath)
      .then((stats) => Date.now() - stats.mtimeMs > STALE_LOCK_AGE_MS)
      .catch(() => false),
  )

/**
 * A live owner still runs the exact process that recorded the lock. A PID that
 * exists but carries a different start identity is a recycled PID and counts
 * as dead. Without a start identity (non-Linux, or a legacy record) liveness
 * falls back conservatively to the PID check alone.
 */
const ownerIsAlive = (owner: LockOwner): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const pidIsAlive = await Promise.resolve()
      .then(() => {
        process.kill(owner.pid, 0)
        return true
      })
      .catch((cause: unknown) => isErrno(cause, 'EPERM'))
    if (!pidIsAlive) return false
    if (owner.startTime === undefined) return true
    const current = await processStartTime(owner.pid)
    if (current === undefined) return true
    return current === owner.startTime
  })

/**
 * Atomically moves a stale lock out of the way. Rename either succeeds for
 * exactly one racer or fails for everyone, so only the rename winner removes
 * the quarantine directory and retries the acquisition; every other starter
 * restarts its inspection instead of racing a recursive delete of a lock that
 * may have just been re-acquired.
 */
const quarantineStaleLock = (lockPath: string): Effect.Effect<boolean> =>
  Effect.promise(() => {
    const quarantinePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`
    return fs
      .rename(lockPath, quarantinePath)
      .then(() => fs.rm(quarantinePath, { recursive: true, force: true }).catch(() => undefined))
      .then(
        () => true,
        () => false,
      )
  })

/** Bound on the recovery loop: each pass either progresses or ends in refusal. */
const MAX_LOCK_RECOVERY_ATTEMPTS = 8

/**
 * Atomically acquires the Friday lifecycle lock (an owner-only lock directory
 * next to the socket) for the server's lifetime, returning the random cleanup
 * token minted for this acquisition. Recovery rules keep stale locks from
 * blocking startup while never stealing a live owner's lock:
 *
 * - a lock whose recorded owner process no longer runs its recorded start
 *   identity is stale
 * - an ownerless lock is stale only once it has aged past STALE_LOCK_AGE_MS
 * - anything else means another Friday already owns this socket
 */
const acquireLifecycleLock = Effect.fn('acquireLifecycleLock')(function* (
  socketPath: string,
): Effect.fn.Return<{ readonly lockPath: string; readonly token: string }, ControlSocketError> {
  const lockPath = lockDirectoryFor(socketPath)
  const alreadyRunning = new ControlSocketError({
    operation: 'already-running',
    path: socketPath,
    detail: 'Another Friday process holds the lifecycle lock for this socket.',
  })
  const acquisitionFailure = (cause: unknown) =>
    new ControlSocketError({
      operation: 'listen',
      path: socketPath,
      detail: 'Could not acquire the Friday lifecycle lock.',
      cause,
    })
  for (let attempt = 0; attempt < MAX_LOCK_RECOVERY_ATTEMPTS; attempt += 1) {
    const first = yield* attemptLock(socketPath)
    if (first.kind === 'acquired') return { lockPath, token: first.token }
    if (first.kind === 'failed') return yield* acquisitionFailure(first.cause)
    const owner = yield* readLockOwner(lockPath)
    const ownerIsDead = Option.isNone(owner)
      ? yield* lockIsStaleAge(lockPath)
      : !(yield* ownerIsAlive(owner.value))
    if (!ownerIsDead) return yield* alreadyRunning
    if (!(yield* quarantineStaleLock(lockPath))) continue
    const second = yield* attemptLock(socketPath)
    if (second.kind === 'acquired') return { lockPath, token: second.token }
    if (second.kind === 'failed') return yield* acquisitionFailure(second.cause)
    // The lock reappeared between quarantine and mkdir: inspect again.
  }
  return yield* alreadyRunning
})

/** Releases the lock only when the recorded ownership token is still ours. */
const releaseLifecycleLock = (lockPath: string, token: string) =>
  Effect.promise(() =>
    fs
      .readFile(lockOwnerFileFor(lockPath), 'utf8')
      .then((raw) => {
        const decoded = decodeLockOwner(raw)
        // A re-acquired lock (another starter's token) must never be removed.
        return Option.isSome(decoded) && decoded.value.token === token
      })
      .catch(() => false),
  ).pipe(
    Effect.flatMap((owned) =>
      owned
        ? Effect.promise(() =>
            fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined),
          )
        : Effect.void,
    ),
  )

export const serveControlSocket = Effect.fn('serveControlSocket')(function* (
  options: ControlSocketServerOptions,
): Effect.fn.Return<ControlSocketServerContract, ControlSocketError, Scope.Scope> {
  const limits: ConnectionLimits = {
    requestByteLimit: options.requestByteLimit ?? DEFAULT_REQUEST_BYTE_LIMIT,
    connectionTimeoutMs: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  }
  yield* ensureOwnerOnlyDirectory(options.path)
  const { lockPath, token } = yield* acquireLifecycleLock(options.path)
  // The lifecycle lock is held until the scope closes (server lifetime); only
  // this process's token may remove it.
  yield* Effect.addFinalizer(() => releaseLifecycleLock(lockPath, token))
  // A socket file from a previous run may remain; only treat it as stale when no
  // process accepts connections, otherwise refuse to shadow the running Friday.
  const existing = yield* statIsSocket(options.path)
  if (existing) {
    const alive = yield* socketIsAlive(options.path)
    if (alive) {
      return yield* new ControlSocketError({
        operation: 'already-running',
        path: options.path,
        detail: 'Another Friday process is serving this control socket.',
      })
    }
    yield* removeSocket(options.path)
  }
  const respond = (line: string): Promise<string> =>
    Effect.runPromise(
      decodeRequestLine(line).pipe(
        Effect.flatMap((request) =>
          request.op === 'config.reload'
            ? options.reload.pipe(Effect.map(encodeOutcomeLine))
            : Effect.succeed(encodeOutcomeLine(reloadFailed('Unknown control operation.'))),
        ),
        // Unparseable requests still receive a structured failure outcome.
        Effect.catch(() =>
          Effect.succeed(encodeOutcomeLine(reloadFailed('Invalid control request.'))),
        ),
      ),
    )
  const liveConnections = new Set<net.Socket>()
  const server = yield* listen(options.path, respond, limits, liveConnections)
  // The bound socket's identity is best-effort: an unobservable socket must not
  // prevent the finalizer below from registering and closing cleanly.
  const boundSocketIdentity = yield* Effect.promise(
    async (): Promise<{ readonly dev: number; readonly ino: number } | undefined> => {
      const stats = await fs.stat(options.path).catch(() => undefined)
      return stats === undefined ? undefined : { dev: stats.dev, ino: stats.ino }
    },
  )
  // Registered immediately after the bind and before every other post-bind
  // step: a chmod failure or an interruption can no longer leak the listening
  // server or the bound socket file.
  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          // Tracked live connections are destroyed so shutdown cannot hang on
          // clients that idle or stall; close() then completes immediately.
          server.close(() => resolve())
          for (const connection of liveConnections) connection.destroy()
        }),
    ).pipe(
      Effect.andThen(
        Effect.promise(async () => {
          // Remove the socket file only when it is still the one we bound (or
          // when its identity was never observable), so a raced shutdown can
          // never delete another server's socket.
          const current = await fs.stat(options.path).catch(() => undefined)
          if (current === undefined) return
          if (
            boundSocketIdentity !== undefined &&
            (current.dev !== boundSocketIdentity.dev || current.ino !== boundSocketIdentity.ino)
          ) {
            return
          }
          await fs.rm(options.path, { force: true }).catch(() => undefined)
        }),
      ),
    ),
  )
  // Only the owning user may talk to the control socket; the restrictive bind
  // umask already enforces this, the chmod keeps it explicit.
  yield* Effect.tryPromise({
    try: () => fs.chmod(options.path, 0o600),
    catch: (cause) =>
      new ControlSocketError({
        operation: 'listen',
        path: options.path,
        detail: 'Could not restrict control socket permissions.',
        cause,
      }),
  })
  return { path: options.path }
})

export interface ControlRequestOptions {
  /** Overall deadline covering connect, request write, and the wait for the response. */
  readonly timeoutMs?: number
  /** Maximum accepted response size; larger responses drop the connection. */
  readonly maxResponseBytes?: number
}

const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 65_536

/** Sends one control request to the running Friday process and returns its structured outcome. */
export const sendControlRequest = Effect.fn('sendControlRequest')(function* (
  path: string,
  request: ControlRequest,
  options: ControlRequestOptions = {},
): Effect.fn.Return<ConfigReloadOutcome, ControlSocketError> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const response = yield* Effect.callback<string, ControlSocketError>((resume) => {
    const client = net.connect({ path })
    let buffered = ''
    let bufferedBytes = 0
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    const settle = (effect: Effect.Effect<string, ControlSocketError>) => {
      if (settled) return
      settled = true
      if (deadline !== undefined) clearTimeout(deadline)
      client.destroy()
      resume(effect)
    }
    const fail = (operation: ControlSocketError['operation'], detail: string, cause?: unknown) =>
      settle(
        Effect.fail(
          new ControlSocketError({
            operation,
            path,
            detail,
            cause,
          }),
        ),
      )
    // One deadline covers the whole exchange: connect, write, and response.
    deadline = setTimeout(() => {
      fail('response-timeout', 'Friday did not respond before the control request deadline.')
    }, timeoutMs)
    client.once('connect', () => {
      client.write(encodeControlRequest(request))
    })
    client.on('data', (chunk: Buffer) => {
      bufferedBytes += chunk.length
      if (bufferedBytes > maxResponseBytes) {
        fail(
          'response-oversized',
          'Friday sent a control response larger than the accepted maximum.',
        )
        return
      }
      buffered += String(chunk)
      const newline = buffered.indexOf('\n')
      if (newline === -1) return
      client.end()
      settle(Effect.succeed(buffered.slice(0, newline)))
    })
    client.once('error', (cause: Error) => {
      fail('connect', 'Could not connect to the running Friday control socket.', cause)
    })
    client.once('close', () => {
      fail('request', 'Friday closed the connection without a response.')
    })
    return Effect.void
  })
  return yield* decodeOutcomeLine(response).pipe(
    Effect.mapError(
      (cause) =>
        new ControlSocketError({
          operation: 'request',
          path,
          detail: 'Friday returned an invalid control socket response.',
          cause,
        }),
    ),
  )
})
