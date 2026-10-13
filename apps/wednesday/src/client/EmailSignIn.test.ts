import { expect } from 'vitest'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { emailSignIn } from './EmailSignIn.ts'

type Attempt = Effect.Success<ReturnType<Parameters<typeof emailSignIn>[0]['create']>>

it.effect(
  'keeps the prepared email attempt and activates only a successfully verified session',
  () =>
    Effect.gen(function* () {
      const calls: string[] = []
      let fail = true
      const verified: Attempt = {
        supportedFirstFactors: null,
        status: 'complete',
        createdSessionId: 'session-a',
        prepareFirstFactor: () => Promise.resolve(verified),
        attemptFirstFactor: () => Promise.resolve(verified),
      }
      const prepared: Attempt = {
        ...verified,
        status: 'needs_first_factor',
        createdSessionId: null,
        attemptFirstFactor: ({ code }) => {
          calls.push(code)
          return fail
            ? Promise.reject({ errors: [{ code: 'form_code_incorrect' }] })
            : Promise.resolve(verified)
        },
      }
      const original: Attempt = {
        ...prepared,
        supportedFirstFactors: [
          { strategy: 'password' },
          { strategy: 'email_code', emailAddressId: 'email-a' },
        ],
        prepareFirstFactor: ({ emailAddressId }) => {
          calls.push(emailAddressId)
          return Promise.resolve(prepared)
        },
        attemptFirstFactor: () => Promise.reject(new Error('Wrong attempt')),
      }
      const signIn = emailSignIn({
        create: () => Effect.succeed(original),
        activate: (session) =>
          Effect.sync(() => {
            calls.push(session)
          }),
      })
      yield* signIn.sendSignInCode('person@example.test')
      const rejected = yield* signIn.verifySignInCode('000000').pipe(Effect.result)
      expect(rejected._tag).toBe('Failure')
      if (rejected._tag === 'Failure')
        expect(rejected.failure.message).toBe('That code is incorrect. Try again.')
      expect(calls).not.toContain('session-a')
      fail = false
      yield* signIn.verifySignInCode('123456')
      expect(calls).toEqual(['email-a', '000000', '123456', 'session-a'])
      expect((yield* signIn.verifySignInCode('123456').pipe(Effect.result))._tag).toBe('Failure')
    }),
)

it.effect('requires email verification and refuses to activate an incomplete sign-in', () =>
  Effect.gen(function* () {
    let activated = false
    const incomplete: Attempt = {
      status: 'needs_second_factor',
      createdSessionId: null,
      supportedFirstFactors: [{ strategy: 'email_code', emailAddressId: 'email' }],
      prepareFirstFactor: () => Promise.resolve(incomplete),
      attemptFirstFactor: () => Promise.resolve(incomplete),
    }
    const signIn = emailSignIn({
      create: () => Effect.succeed(incomplete),
      activate: () =>
        Effect.sync(() => {
          activated = true
        }),
    })
    expect((yield* signIn.verifySignInCode('123456').pipe(Effect.result))._tag).toBe('Failure')
    yield* signIn.sendSignInCode('person@example.test')
    expect((yield* signIn.verifySignInCode('123456').pipe(Effect.result))._tag).toBe('Failure')
    expect(activated).toBe(false)
  }),
)
