/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/crypto-random-uuid, effecttsgo/node-builtin-import, effecttsgo/process-env, effecttsgo/process-env-in-effect -- These focused tests exercise the installed process backend and temporarily isolate PATH. */

import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RepositoryWorktreeError } from './RepositoryWorktrees.ts'
import { runProcess } from './RepositoryWorktreesProcess.ts'

const processFixture = fileURLToPath(
  new URL('./RepositoryWorktreesProcessFixture.ts', import.meta.url),
)
const isWorktreeError = Schema.is(RepositoryWorktreeError)

const processFailure = (cause: PlatformError.PlatformError) =>
  new RepositoryWorktreeError({
    operation: 'inspect',
    detail: 'Process test failed.',
    cause,
  })

const runFixture = (mode: string) =>
  runProcess(process.execPath, [processFixture, mode], processFailure)

const processIsRunning = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })

describe('RepositoryWorktrees runProcess', () => {
  it.effect('captures trimmed stdout, stderr, and a nonzero exit code', () =>
    Effect.gen(function* () {
      const result = yield* runFixture('failure')

      assert.deepStrictEqual(result, {
        stdout: 'fixture stdout',
        stderr: 'fixture failure',
        exitCode: 7,
      })
    }),
  )

  it.effect('inherits environment, disables Git prompts, and ignores stdin', () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.FRDAY_PROCESS_TEST
        process.env.FRDAY_PROCESS_TEST = 'from-parent'
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const result = yield* runFixture('env-stdin')

          assert.strictEqual(result.stdout, 'from-parent:0:')
          assert.strictEqual(result.stderr, '')
          assert.strictEqual(result.exitCode, 0)
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.FRDAY_PROCESS_TEST
          else process.env.FRDAY_PROCESS_TEST = previous
        }),
    ),
  )

  it.effect('drains high-volume stdout and stderr concurrently', () =>
    Effect.gen(function* () {
      const result = yield* runFixture('volume')

      assert.strictEqual(result.stdout.length, 512 * 1024)
      assert.strictEqual(result.stderr.length, 512 * 1024)
      assert.match(result.stdout, /^x+$/u)
      assert.match(result.stderr, /^y+$/u)
      assert.strictEqual(result.exitCode, 0)
    }),
  )

  it.effect('maps a missing executable PlatformError to RepositoryWorktreeError', () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.PATH
        process.env.PATH = ''
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const error = yield* runProcess('friday-process-test-missing', [], processFailure).pipe(
            Effect.flip,
          )

          assert(isWorktreeError(error))
          assert.strictEqual(error.operation, 'inspect')
          assert(error.cause instanceof PlatformError.PlatformError)
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.PATH
          else process.env.PATH = previous
        }),
    ),
  )

  it('terminates the direct child when interrupted', async () => {
    const pidFile = join(tmpdir(), `friday-process-${crypto.randomUUID()}.pid`)
    const fiber = Effect.runFork(
      runProcess(process.execPath, [processFixture, 'wait', pidFile], processFailure),
    )
    const pid = await Effect.runPromise(
      Effect.eventually(
        Effect.tryPromise(() => readFile(pidFile, 'utf8')).pipe(Effect.delay('10 millis')),
      ).pipe(Effect.map(Number)),
    )

    assert.strictEqual(await Effect.runPromise(processIsRunning(pid)), true)
    fiber.interruptUnsafe()
    const runningAfterInterruption = await Effect.runPromise(
      Effect.eventually(
        processIsRunning(pid).pipe(
          Effect.filterOrFail((isRunning) => !isRunning),
          Effect.delay('10 millis'),
        ),
      ),
    )
    assert.strictEqual(runningAfterInterruption, false)
    await rm(pidFile, { force: true })
  })
})
