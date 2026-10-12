import { verifyToken } from '@clerk/backend'
import { Config, Context, Effect, Layer, Schema } from 'effect'
import { failure } from './errors.ts'

export class Auth extends Context.Service<
  Auth,
  {
    readonly publishableKey: string
    readonly origin: string
    readonly verify: (
      token: string,
    ) => Effect.Effect<{ userId: string; expiresAt: number }, ReturnType<typeof failure>>
  }
>()('@wednesday/Auth') {}
const decodeSession = Schema.decodeUnknownEffect(
  Schema.Struct({
    sub: Schema.NonEmptyString,
    sid: Schema.NonEmptyString,
    iss: Schema.NonEmptyString,
    exp: Schema.Int,
    sts: Schema.optionalKey(Schema.Literal('active')),
  }),
)

export const authLayer = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const publishableKey = yield* Config.NonEmptyString('CLERK_PUBLISHABLE_KEY')
    const jwtKey = yield* Config.NonEmptyString('CLERK_JWT_KEY')
    const issuer = `https://${Buffer.from(publishableKey.slice(8), 'base64').toString('utf8').replace(/\$$/, '')}`
    const origin = yield* Config.String('WEDNESDAY_ORIGIN').pipe(
      Config.withDefault('http://localhost:3002'),
    )
    if (!publishableKey.startsWith('pk_test_'))
      return yield* failure('Wednesday currently requires Clerk development keys.')
    const verify = Effect.fn('Auth.verify')(function* (token: string) {
      const claims = yield* Effect.tryPromise({
        try: () => verifyToken(token, { jwtKey, authorizedParties: [origin] }),
        catch: () => failure('Your session could not be verified. Sign in again.'),
      })
      const session = yield* decodeSession(claims).pipe(
        Effect.mapError(() => failure('A signed-in user session is required.')),
      )
      if (session.exp * 1000 <= Date.now())
        return yield* failure('Your session expired. Sign in again.')
      if (session.iss !== issuer || !session.sub.startsWith('user_'))
        return yield* failure('This session belongs to another application.')
      return { userId: session.sub, expiresAt: session.exp * 1000 }
    })
    return Auth.of({ publishableKey, origin, verify })
  }),
)
