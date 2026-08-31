/* oxlint-disable effecttsgo/node-builtin-import -- The control socket uses Node net and fs, which run under both the Bun application runtime and the Node test runtime. */

import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as Effect from 'effect/Effect'
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
  operation: Schema.Literals(['listen', 'stale-socket', 'already-running', 'connect', 'request']),
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
}

/** One request per connection: a JSON line in, a JSON line out. */
const serveConnection = (
  connection: net.Socket,
  respond: (line: string) => Promise<string>,
): void => {
  let buffered = ''
  connection.on('data', (chunk) => {
    buffered += String(chunk)
    const newline = buffered.indexOf('\n')
    if (newline === -1) return
    const line = buffered.slice(0, newline)
    buffered = buffered.slice(newline + 1)
    void respond(line)
      .then((response) => {
        connection.end(response)
      })
      .catch(() => {
        connection.end()
      })
  })
  connection.on('error', () => {
    connection.destroy()
  })
}

const listen = (
  path: string,
  respond: (line: string) => Promise<string>,
): Effect.Effect<net.Server, ControlSocketError> =>
  Effect.callback((resume) => {
    const server = net.createServer((connection) => {
      serveConnection(connection, respond)
    })
    const fail = (cause: Error) => {
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
      server.removeListener('error', fail)
      resume(Effect.succeed(server))
    })
    return Effect.sync(() => {
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

export const serveControlSocket = Effect.fn('serveControlSocket')(function* (
  options: ControlSocketServerOptions,
): Effect.fn.Return<ControlSocketServerContract, ControlSocketError, Scope.Scope> {
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
  const server = yield* listen(options.path, (line) =>
    Effect.runPromise(
      decodeRequestLine(line).pipe(
        Effect.flatMap((request) =>
          request.op === 'config.reload'
            ? options.reload.pipe(Effect.map(encodeOutcomeLine))
            : Effect.succeed(encodeOutcomeLine(reloadFailed('Unknown control operation.'))),
        ),
      ),
    ),
  )
  // Only the owning user may talk to the control socket.
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
  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => fs.rm(options.path, { force: true }),
          catch: () => undefined,
        }).pipe(Effect.ignore),
      ),
    ),
  )
  return { path: options.path }
})

/** Sends one control request to the running Friday process and returns its structured outcome. */
export const sendControlRequest = Effect.fn('sendControlRequest')(function* (
  path: string,
  request: ControlRequest,
): Effect.fn.Return<ConfigReloadOutcome, ControlSocketError> {
  const response = yield* Effect.callback<string, ControlSocketError>((resume) => {
    const client = net.connect({ path })
    let buffered = ''
    let settled = false
    const settle = (effect: Effect.Effect<string, ControlSocketError>) => {
      if (settled) return
      settled = true
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
    client.once('connect', () => {
      client.write(encodeControlRequest(request))
    })
    client.on('data', (chunk) => {
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
