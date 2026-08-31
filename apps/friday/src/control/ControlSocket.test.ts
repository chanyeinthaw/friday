/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide -- The control socket tests exercise real Node sockets. */

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { mkdtemp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NodeFs from 'node:fs'

import {
  ControlRequest,
  ControlSocketError,
  encodeControlRequest,
  sendControlRequest,
  serveControlSocket,
} from './ControlSocket.ts'
import { reloadFailed, reloadSucceeded } from '../config/ConfigReload.ts'

const isControlSocketError = Schema.is(ControlSocketError)
const decodeRequest = Schema.decodeSync(ControlRequest)

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
