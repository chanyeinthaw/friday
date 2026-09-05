/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide -- The private process helper provides its narrow Bun layer locally. */

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as PlatformError from 'effect/PlatformError'
import * as Stream from 'effect/Stream'
import * as String from 'effect/String'
import * as BunChildProcessSpawner from '@effect/platform-bun/BunChildProcessSpawner'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as BunPath from '@effect/platform-bun/BunPath'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const processPlatformLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
)

/** Runs one external process and captures its trimmed output and exit code. */
export const runProcess = Effect.fn('RepositoryWorktrees.runProcess')(function* <E>(
  command: string,
  arguments_: ReadonlyArray<string>,
  failure: (cause: PlatformError.PlatformError) => E,
) {
  return yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, [...arguments_], {
        env: { GIT_TERMINAL_PROMPT: '0' },
        extendEnv: true,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: false,
      }),
    )
    const [stdout, stderr, exitCode] = yield* Effect.uninterruptibleMask((restore) =>
      restore(
        Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: 'unbounded' },
        ),
      ).pipe(Effect.onInterrupt(() => handle.kill())),
    )
    return {
      stdout: String.trim(stdout),
      stderr: String.trim(stderr),
      exitCode,
    } satisfies CommandResult
  }).pipe(Effect.scoped, Effect.provide(processPlatformLayer), Effect.mapError(failure))
})
