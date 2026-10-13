import { Effect, Schema } from 'effect'

interface SignInAttempt {
  readonly supportedFirstFactors:
    | readonly { readonly strategy: string; readonly emailAddressId?: string }[]
    | null
  readonly status: string | null
  readonly createdSessionId: string | null
  readonly prepareFirstFactor: (params: {
    strategy: 'email_code'
    emailAddressId: string
  }) => Promise<SignInAttempt>
  readonly attemptFirstFactor: (params: {
    strategy: 'email_code'
    code: string
  }) => Promise<SignInAttempt>
}

const decodeSignInErrors = Schema.decodeUnknownOption(
  Schema.Struct({
    errors: Schema.Array(
      Schema.Struct({
        code: Schema.String,
        longMessage: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
)
export const signInError = (cause: unknown) => {
  const decoded = decodeSignInErrors(cause)
  const error = decoded._tag === 'Some' ? decoded.value.errors[0] : undefined
  switch (error?.code) {
    case 'form_code_incorrect':
      return new Error('That code is incorrect. Try again.')
    case 'verification_expired':
      return new Error('That code has expired. Send another code and try again.')
    case 'form_identifier_not_found':
    case 'not_allowed_access':
    case 'sign_up_restricted':
      return new Error(
        'This email does not have access yet. Join the waitlist or try another email.',
      )
    case 'too_many_requests':
      return new Error('Too many attempts. Wait a moment and try again.')
    default:
      return new Error(error?.longMessage || error?.message || 'Could not sign in. Try again.')
  }
}

// Keep the attempt that sent this tab's code instead of verifying a different tab's sign-in.
export const emailSignIn = (client: {
  readonly create: (email: string) => Effect.Effect<SignInAttempt, Error>
  readonly activate: (session: string) => Effect.Effect<void, Error>
}) => {
  let current: SignInAttempt | undefined
  const sendSignInCode = Effect.fn('EmailSignIn.sendCode')(function* (email: string) {
    const attempt = yield* client.create(email)
    const factor = attempt.supportedFirstFactors?.find((item) => item.strategy === 'email_code')
    if (!factor?.emailAddressId)
      return yield* Effect.fail(new Error('Email sign-in is not available for this account.'))
    const emailAddressId = factor.emailAddressId
    current = yield* Effect.tryPromise({
      try: () =>
        attempt.prepareFirstFactor({
          strategy: 'email_code',
          emailAddressId,
        }),
      catch: signInError,
    })
  })
  const verifySignInCode = Effect.fn('EmailSignIn.verifyCode')(function* (code: string) {
    const attempt = current
    if (!attempt) return yield* Effect.fail(new Error('Enter your email to get a new code.'))
    const verified = yield* Effect.tryPromise({
      try: () => attempt.attemptFirstFactor({ strategy: 'email_code', code }),
      catch: signInError,
    })
    if (verified.status !== 'complete' || !verified.createdSessionId)
      return yield* Effect.fail(new Error('This account needs another verification step.'))
    yield* client.activate(verified.createdSessionId)
    current = undefined
  })
  return { sendSignInCode, verifySignInCode }
}
