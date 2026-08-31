/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide -- The control socket tests exercise real Node sockets. */

import { assert, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { mkdtemp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NodeFs from 'node:fs'
import * as net from 'node:net'
import { dirname } from 'node:path'

import {
  ControlRequest,
  ControlSocketError,
  encodeControlRequest,
  sendControlRequest,
  serveControlSocket,
} from './ControlSocket.ts'
import { ConfigReloadOutcome, reloadFailed, reloadSucceeded } from '../config/ConfigReload.ts'

const isControlSocketError = Schema.is(ControlSocketError)
const decodeRequest = Schema.decodeSync(ControlRequest)
const decodeOutcome = Schema.decodeSync(ConfigReloadOutcome)

const makePath = Effect.promise(() =>
  mkdtemp(join(tmpdir(), 'friday-control-')).then((dir) => join(dir, 'friday.sock')),
)

it('round-trips the config.reload request through the shared schema', () => {
  const decoded = decodeRequest(JSON.parse(encodeControlRequest({ op: 'config.reload' })))
  assert.deepStrictEqual(decoded, { op: 'config.reload' })
})

it.effect('serves a reload request with a structured outcome and cleans up the socket', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(9)) })
        const outcome = yield* sendControlRequest(path, { op: 'config.reload' })
        assert.deepStrictEqual(outcome, { ok: true, version: 9 })
      }),
    )
    // Lifecycle cleanup removes the socket file when the scope closes.
    assert.strictEqual(NodeFs.existsSync(path), false)
  }),
)

it.effect('reports server-side reload failures as failed outcomes', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({
          path,
          reload: Effect.succeed(reloadFailed('Stored Friday configuration is invalid.')),
        })
        const outcome = yield* sendControlRequest(path, { op: 'config.reload' })
        assert.deepStrictEqual(outcome, {
          ok: false,
          reason: 'reload-failed',
          detail: 'Stored Friday configuration is invalid.',
        })
      }),
    )
  }),
)

it.effect('replaces a stale socket file left by a previous run', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    // Reproduce a killed Friday: a child binds the socket and is SIGKILLed, so
    // the socket file remains with no process behind it.
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)})`],
            { stdio: 'ignore' },
          )
          const poll = setInterval(() => {
            if (NodeFs.existsSync(path)) {
              clearInterval(poll)
              child.kill('SIGKILL')
              child.on('exit', () => resolve())
            }
          }, 25)
          child.on('error', reject)
        }),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(1)) })
        const outcome = yield* sendControlRequest(path, { op: 'config.reload' })
        assert.deepStrictEqual(outcome, { ok: true, version: 1 })
      }),
    )
  }),
)

it.effect('refuses to shadow another running Friday process', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        // The first server holds its scope open inside this block.
        yield* serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(2)) })
        const error = yield* Effect.flip(
          serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(3)) }),
        )
        assert(isControlSocketError(error))
        assert.strictEqual(error.operation, 'already-running')
      }),
    )
  }),
)

it.effect('restricts socket permissions to the owning user', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(1)) })
        const mode = (yield* Effect.promise(() => NodeFs.promises.stat(path))).mode & 0o777
        assert.strictEqual(mode, 0o600)
      }),
    )
  }),
)

it.effect('fails with a typed error when no Friday process is running', () =>
  Effect.gen(function* () {
    const path = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), 'friday-control-')).then((dir) => join(dir, 'missing.sock')),
    )
    const error = yield* Effect.flip(sendControlRequest(path, { op: 'config.reload' }))
    assert(isControlSocketError(error))
    assert.strictEqual(error.operation, 'connect')
  }),
)

/** Opens a raw client connection used to exercise server-side connection limits. */
const connectRaw = (path: string): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const client = net.connect({ path })
    client.once('connect', () => resolve(client))
    client.once('error', reject)
  })

const waitForClose = (socket: net.Socket): Promise<void> =>
  new Promise((resolve) => {
    if (socket.destroyed || !socket.writable) return resolve()
    socket.once('close', () => resolve())
  })

const readResponse = (socket: net.Socket): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += String(chunk)
      const newline = buffered.indexOf('\n')
      if (newline !== -1) resolve(buffered.slice(0, newline))
    })
    socket.once('close', () => {
      if (buffered.indexOf('\n') === -1) reject(new Error('connection closed without a response'))
    })
    socket.once('error', reject)
  })

it.effect('destroys oversized clients instead of buffering without bound', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({
          path,
          reload: Effect.succeed(reloadSucceeded(1)),
          requestByteLimit: 64,
        })
        const client = yield* Effect.promise(() => connectRaw(path))
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              client.once('close', () => resolve())
              client.once('error', reject)
              client.write(`${'x'.repeat(65)}\n`)
            }),
        )
        // The oversized client was destroyed without a structured response.
        assert(client.destroyed)
      }),
    )
  }),
)

it.effect('destroys idle clients after the connection timeout', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({
          path,
          reload: Effect.succeed(reloadSucceeded(1)),
          connectionTimeoutMs: 50,
        })
        const client = yield* Effect.promise(() => connectRaw(path))
        // The client sends nothing; the server must reap it without any test sleep.
        yield* Effect.promise(() => waitForClose(client))
        assert(client.destroyed)
      }),
    )
  }),
)

it.effect('destroys clients that send multiple or trailing requests', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({
          path,
          reload: Effect.succeed(reloadSucceeded(1)),
          connectionTimeoutMs: 2000,
        })
        for (const payload of [
          `${encodeControlRequest({ op: 'config.reload' })}${encodeControlRequest({ op: 'config.reload' })}`,
          `${encodeControlRequest({ op: 'config.reload' })}trailing\n`,
        ]) {
          const client = yield* Effect.promise(() => connectRaw(path))
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                client.once('close', () => resolve())
                client.once('error', reject)
                client.write(payload)
              }),
          )
          assert(client.destroyed)
        }
      }),
    )
  }),
)

it.effect('answers invalid requests with a structured failure outcome', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({
          path,
          reload: Effect.succeed(reloadSucceeded(1)),
          connectionTimeoutMs: 2000,
        })
        const client = yield* Effect.promise(() => connectRaw(path))
        client.write('not-json\n')
        const line = yield* Effect.promise(() => readResponse(client))
        assert.deepStrictEqual(decodeOutcome(JSON.parse(line)), {
          ok: false,
          reason: 'reload-failed',
          detail: 'Invalid control request.',
        })
      }),
    )
  }),
)

it.effect('finalization destroys tracked live clients so shutdown cannot hang', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({
          path,
          reload: Effect.succeed(reloadSucceeded(1)),
          // A generous timeout would keep idle clients (and server.close) alive;
          // finalization must destroy them regardless.
          connectionTimeoutMs: 60_000,
        })
        yield* Effect.promise(() => connectRaw(path))
        // Scope close below must complete promptly even with the open client.
      }),
    )
    assert.strictEqual(NodeFs.existsSync(path), false)
  }),
)

it.effect('creates the socket and its directory owner-only under a permissive umask', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    const directory = dirname(path)
    const previousUmask = yield* Effect.sync(() => process.umask(0o000))
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(1)) })
        const socketMode = (yield* Effect.promise(() => NodeFs.promises.stat(path))).mode & 0o777
        const directoryMode =
          (yield* Effect.promise(() => NodeFs.promises.stat(directory))).mode & 0o777
        assert.strictEqual(socketMode, 0o600)
        assert.strictEqual(directoryMode, 0o700)
      }),
    ).pipe(
      // The bind ran under a temporary restrictive umask; restore the test's.
      Effect.ensuring(Effect.sync(() => process.umask(previousUmask))),
    )
  }),
)

it.effect('exactly one concurrent starter wins the lifecycle lock', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    yield* Effect.scoped(
      Effect.gen(function* () {
        const results = yield* Effect.forEach(
          [1, 2, 3],
          () =>
            Effect.exit(serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(1)) })),
          { concurrency: 'unbounded', discard: false },
        )
        const successes = results.filter(Exit.isSuccess)
        const failures = results.filter(Exit.isFailure)
        assert.strictEqual(successes.length, 1)
        assert.strictEqual(failures.length, 2)
        for (const failure of failures) {
          const error = Cause.squash(failure.cause)
          assert(isControlSocketError(error))
          assert.strictEqual(error.operation, 'already-running')
        }
        // The winner holds the lock for its lifetime; a fresh start refuses.
        const error = yield* Effect.flip(
          serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(2)) }),
        )
        assert(isControlSocketError(error))
        assert.strictEqual(error.operation, 'already-running')
        // And the winner still serves requests.
        const outcome = yield* sendControlRequest(path, { op: 'config.reload' })
        assert.deepStrictEqual(outcome, { ok: true, version: 1 })
      }),
    )
    // After the winner's scope closes, the lock is released and a new server starts.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(2)) })
        const outcome = yield* sendControlRequest(path, { op: 'config.reload' })
        assert.deepStrictEqual(outcome, { ok: true, version: 2 })
      }),
    )
  }),
)

it.effect('does not steal a fresh ownerless lock from a concurrent starter', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    // An ownerless lock directory that just appeared: another starter may be
    // between creating it and recording its PID, so it must not be stolen.
    yield* Effect.promise(() => NodeFs.promises.mkdir(`${path}.lock`, { recursive: true }))
    const error = yield* Effect.flip(
      serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(1)) }),
    )
    assert(isControlSocketError(error))
    assert.strictEqual(error.operation, 'already-running')
    assert.strictEqual(NodeFs.existsSync(`${path}.lock`), true)
  }),
)

it.effect('recovers a stale lifecycle lock left by a dead process', () =>
  Effect.gen(function* () {
    const path = yield* makePath
    const lockPath = `${path}.lock`
    // A lock directory whose recorded owner process no longer exists.
    const deadChild = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid: number = yield* Effect.promise(
      () =>
        new Promise<number>((resolve) => {
          deadChild.on('exit', () => resolve(deadChild.pid ?? 0))
        }),
    )
    yield* Effect.promise(() =>
      NodeFs.promises
        .mkdir(lockPath, { recursive: true })
        .then(() => NodeFs.promises.writeFile(`${lockPath}/owner.pid`, `${deadPid}\n`)),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(5)) })
        const outcome = yield* sendControlRequest(path, { op: 'config.reload' })
        assert.deepStrictEqual(outcome, { ok: true, version: 5 })
      }),
    )
    // The recovered lock is released on shutdown.
    assert.strictEqual(NodeFs.existsSync(lockPath), false)
  }),
)
