import { Effect, ManagedRuntime, Stream } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { Browser, browserLayer } from './Browser.ts'
import { initialModel, update } from './App.ts'
import type { MemoryQuery } from '../shared/Memory.ts'
import { Message } from './Messages.ts'

// The registry owns shared chat state; HTTP replies and SSE use the same reducer.
export const registry = AtomRegistry.make()
export const readyAtom = Atom.make(false).pipe(Atom.keepAlive)
export const stateAtom = Atom.make(initialModel).pipe(Atom.keepAlive)
const runtime = ManagedRuntime.make(browserLayer)
export const dispatch = (message: Message) => {
  const next = update(registry.get(stateAtom), message)
  registry.set(stateAtom, next.model)
  for (const command of next.commands ?? []) {
    const generation = next.model.generation
    void runtime.runPromise(
      command.pipe(
        Effect.map((result) => {
          if (registry.get(stateAtom).generation === generation) dispatch(result)
        }),
      ),
    )
  }
}
export const start = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const browser = yield* Browser
      yield* browser.sessionChanges.pipe(
        Stream.changesWith((a, b) => a.userId === b.userId),
        Stream.tap((session) =>
          Effect.sync(() => {
            registry.set(readyAtom, true)
            dispatch(Message.SessionChanged(session))
          }),
        ),
        Stream.switchMap((session) => (session.userId ? browser.connect() : Stream.empty)),
        Stream.runForEach((event) => Effect.sync(() => dispatch(Message.Received({ event })))),
      )
    }),
  )
export const dispose = () => runtime.dispose()

export const sendSignInCode = (email: string) =>
  runtime.runPromise(Effect.flatMap(Browser, (browser) => browser.sendSignInCode(email)))
export const verifySignInCode = (code: string) =>
  runtime.runPromise(Effect.flatMap(Browser, (browser) => browser.verifySignInCode(code)))

export const browseMemory = (query: MemoryQuery, signal: AbortSignal) =>
  runtime.runPromise(
    Effect.flatMap(Browser, (browser) => browser.memory(query)),
    { signal },
  )
export const readMemoryOriginal = (id: number, signal: AbortSignal) =>
  runtime.runPromise(
    Effect.flatMap(Browser, (browser) => browser.memoryOriginal(id)),
    { signal },
  )

const uploadControllers = new Map<string, AbortController>()
export const cancelUpload = (id: string) => {
  dispatch(Message.UploadCancelled({ id }))
  uploadControllers.get(id)?.abort()
}
export const uploadAttachment = (file: File) => {
  const generation = registry.get(stateAtom).generation
  const id = crypto.randomUUID()
  const source = file.type.startsWith('image/') ? URL.createObjectURL(file) : ''
  const controller = new AbortController()
  uploadControllers.set(id, controller)
  dispatch(
    Message.UploadStarted({
      upload: { id, name: file.name, mediaType: file.type, source, progress: 0 },
    }),
  )
  const current = () =>
    registry.get(stateAtom).generation === generation && !controller.signal.aborted
  void runtime
    .runPromise(
      Effect.gen(function* () {
        const browser = yield* Browser
        const attachment = yield* browser.upload(file, (progress) => {
          if (current()) dispatch(Message.UploadProgress({ id, progress }))
        })
        return Message.AttachmentUploaded({ id, attachment })
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(Message.UploadFailed({ id, message: error.message })),
        ),
        Effect.tap((message) =>
          Effect.sync(() => {
            if (current()) dispatch(message)
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            uploadControllers.delete(id)
            if (source) URL.revokeObjectURL(source)
          }),
        ),
      ),
      { signal: controller.signal },
    )
    .catch(() => undefined)
}
export const downloadAttachment = (id: string, signal: AbortSignal) =>
  runtime.runPromise(
    Effect.flatMap(Browser, (browser) => browser.download(id)),
    { signal },
  )

export const loadFirecrawl = (signal: AbortSignal) =>
  runtime.runPromise(
    Effect.flatMap(Browser, (browser) => browser.firecrawl()),
    { signal },
  )
export const connectFirecrawl = (apiKey: string, signal: AbortSignal) =>
  runtime.runPromise(
    Effect.flatMap(Browser, (browser) => browser.connectFirecrawl(apiKey)),
    { signal },
  )
export const disconnectFirecrawl = (signal: AbortSignal) =>
  runtime.runPromise(
    Effect.flatMap(Browser, (browser) => browser.disconnectFirecrawl()),
    { signal },
  )

export const clearConversation = () =>
  runtime.runPromise(
    Effect.flatMap(Browser, (browser) => browser.send({ _tag: 'ClearConversation' })),
  )
