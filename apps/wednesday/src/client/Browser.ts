import { Clerk } from '@clerk/clerk-js'
import { Context, Effect, Layer, Queue, Schedule, Schema, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import { HttpApiClient } from 'effect/http-api'
import { Api, Unauthorized } from '../shared/Api.ts'
import { WednesdayError } from '../server/errors.ts'
import { ClientCommand, type ServerEvent } from '../shared/protocol.ts'

export interface SessionChange {
  readonly userId: string
}
export class Browser extends Context.Service<
  Browser,
  {
    readonly sessionChanges: Stream.Stream<SessionChange>
    readonly connect: () => Stream.Stream<ServerEvent>
    readonly signOut: Effect.Effect<void, Error>
    readonly send: (command: ClientCommand) => Effect.Effect<void, Error>
  }
>()('@wednesday/Browser') {}
const Config = Schema.Struct({ publishableKey: Schema.NonEmptyString })
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config))

export const browserLayer = Layer.effect(
  Browser,
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() => fetch('/config'))
    const config = yield* decodeConfig(yield* Effect.tryPromise(() => response.text()))
    const clerk = new Clerk(config.publishableKey)
    yield* Effect.tryPromise(() =>
      clerk.load({
        ui: {
          ClerkUI: import('@clerk/ui').then(({ ui }) => {
            if (!ui.ClerkUI) throw new Error('Authentication UI could not load.')
            return ui.ClerkUI
          }),
        },
        appearance: {
          variables: {
            colorBackground: '#ffffff',
            colorForeground: '#27272a',
            colorPrimary: '#4f46e5',
            borderRadius: '0.75rem',
          },
        },
        signInFallbackRedirectUrl: '/',
        signUpFallbackRedirectUrl: '/',
        afterSignOutUrl: '/',
        signInUrl: '/',
        waitlistUrl: '/waitlist',
      }),
    )
    customElements.define(
      'wednesday-auth',
      class extends HTMLElement {
        connectedCallback() {
          const node = document.createElement('div')
          this.append(node)
          if (location.pathname === '/waitlist') clerk.mountWaitlist(node)
          else clerk.mountSignIn(node, { routing: 'hash' })
        }
        disconnectedCallback() {
          const node = this.children[0]
          if (!(node instanceof HTMLDivElement)) return
          if (location.pathname === '/waitlist') clerk.unmountWaitlist(node)
          else clerk.unmountSignIn(node)
        }
      },
    )
    const responses = yield* Queue.unbounded<{
      readonly userId: string
      readonly event: ServerEvent
    }>()
    const http = yield* HttpClient.HttpClient
    const authenticated = HttpClient.mapRequestEffect(http, (request) =>
      Effect.gen(function* () {
        const token = yield* Effect.tryPromise(
          () => clerk.session?.getToken() ?? Promise.resolve(null),
        )
        if (!token) return yield* Effect.fail(new Error('Sign in again to continue.'))
        return HttpClientRequest.bearerToken(request, token)
      }),
    )
    const api = yield* HttpApiClient.makeWith(Api, {
      baseUrl: location.origin,
      httpClient: authenticated,
    })
    const send = Effect.fn('Browser.send')(function* (command: ClientCommand) {
      const userId = clerk.user?.id ?? ''
      const result = yield* Effect.gen(function* () {
        switch (command._tag) {
          case 'StartChatGpt':
            return yield* api.chat.startChatGpt()
          case 'PollChatGpt':
            return yield* api.chat.pollChatGpt({ payload: { attemptId: command.attemptId } })
          case 'CancelChatGpt':
            return yield* api.chat.cancelChatGpt({ payload: { attemptId: command.attemptId } })
          case 'DisconnectChatGpt':
            return yield* api.chat.disconnectChatGpt()
          case 'Load':
            return yield* api.chat.conversation()
          case 'LoadOlder':
            return yield* api.chat.history({ query: { beforeId: command.beforeId } })
          case 'Send':
            return yield* api.chat.send({
              payload: { requestId: command.requestId, text: command.text },
            })
          case 'Steer':
            return yield* api.chat.steer({
              payload: { requestId: command.requestId, text: command.text, turnId: command.turnId },
            })
          case 'Stop':
            return yield* api.chat.stop({ payload: command })
          case 'SaveSettings':
            return yield* api.chat.saveSettings({
              payload: { settings: command.settings, apiKey: command.apiKey },
            })
          case 'DiscoverModels':
            return yield* api.chat.discoverModels({
              payload: command,
            })
        }
      }).pipe(
        Effect.mapError(
          (error) =>
            new Error(
              error instanceof WednesdayError || error instanceof Unauthorized
                ? error.message
                : 'Your request could not be completed. Please try again.',
            ),
        ),
      )
      if (clerk.user?.id === userId) {
        for (const event of result) yield* Queue.offer(responses, { userId, event })
      }
    })
    const sessionChanges = Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<SessionChange>()
        const unsubscribe = clerk.addListener((state) => {
          Queue.offerUnsafe(queue, { userId: state.user?.id ?? '' })
        })
        yield* Queue.offer(queue, { userId: clerk.user?.id ?? '' })
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
        return Stream.fromQueue(queue)
      }),
    )
    const connect = () => {
      let afterId = -1
      const events = Stream.suspend(() => {
        let streamId: string | undefined
        const renew = Effect.suspend(() =>
          streamId
            ? api.chat.renewEvents({ payload: { streamId } }).pipe(Effect.asVoid)
            : Effect.void,
        ).pipe(Effect.repeat(Schedule.spaced('20 seconds')))
        return Stream.make({ _tag: 'Connecting' } satisfies ServerEvent).pipe(
          Stream.concat(Stream.unwrap(api.chat.events({ query: { afterId } }))),
          Stream.interruptWhen(renew),
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event._tag === 'Ready') streamId = event.streamId
              if (event._tag === 'Message') afterId = Math.max(afterId, event.message.id)
              if (event._tag === 'Snapshot')
                for (const message of event.messages) afterId = Math.max(afterId, message.id)
            }),
          ),
        )
      }).pipe(
        Stream.catch(() =>
          Stream.make({
            _tag: 'Connecting',
          } satisfies ServerEvent),
        ),
        Stream.repeat(Schedule.spaced('1 second')),
      )
      return Stream.merge(
        Stream.fromQueue(responses).pipe(
          Stream.filter((reply) => reply.userId === clerk.user?.id),
          Stream.map((reply) => reply.event),
        ),
        events,
      )
    }
    const signOut = Effect.tryPromise({
      try: () => clerk.signOut(),
      catch: () => new Error('Could not sign out.'),
    })
    return Browser.of({ send, connect, sessionChanges, signOut })
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
