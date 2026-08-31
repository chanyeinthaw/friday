/* oxlint-disable effecttsgo/node-builtin-import, anti-slop/no-module-mocking, anti-slop/no-runtime-typeof, effect-local/no-manual-effect-runtime-in-tests -- Node's fs module has no injection seam: mocking the single chmod call is the only way to fail a post-bind step deterministically without adding test-only API to the server's public options. */

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NodeFs from 'node:fs'
import { describe, vi } from 'vitest'

import { ControlSocketError, serveControlSocket } from './ControlSocket.ts'
import { reloadSucceeded } from '../config/ConfigReload.ts'

const isControlSocketError = Schema.is(ControlSocketError)

/** Injection switch: fail exactly the socket-file chmod that follows the bind. */
const fault = vi.hoisted(() => ({ failSocketChmod: false, socketPath: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const chmod = (path: string, mode: number): Promise<void> =>
    fault.failSocketChmod && path === fault.socketPath
      ? Promise.reject(new Error('injected chmod failure'))
      : actual.chmod(path, mode)
  return { ...actual, chmod }
})

describe('ControlSocket fault injection', () => {
  it.effect('cleans up the bound socket and lock when a post-bind step fails', () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), 'friday-control-fault-')),
      )
      const path = join(directory, 'friday.sock')
      fault.socketPath = path
      fault.failSocketChmod = true
      const error = yield* Effect.flip(
        Effect.scoped(serveControlSocket({ path, reload: Effect.succeed(reloadSucceeded(1)) })),
      )
      fault.failSocketChmod = false
      // The failure is the injected post-bind chmod failure itself.
      assert(isControlSocketError(error))
      assert.strictEqual(error.operation, 'listen')
      assert.strictEqual(error.detail, 'Could not restrict control socket permissions.')
      // The close/unlink finalizer was registered before the failing step, so
      // neither the listening server's socket file nor the lifecycle leaks.
      assert.strictEqual(NodeFs.existsSync(path), false)
      assert.strictEqual(NodeFs.existsSync(`${path}.lock`), false)
    }),
  )
})
