import { Effect, Layer } from 'effect'
import { HttpMiddleware, HttpPlatform, HttpRouter, HttpServerResponse } from 'effect/http'
import frontend from 'wednesday:frontend'
import { buildId } from '../shared/Build.ts'

// Bun embeds these files in the executable; routing them through Effect enables compression.
export const frontendLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      'GET',
      '/version',
      HttpServerResponse.text(JSON.stringify({ id: buildId }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }),
    )
    for (const file of frontend) {
      const html = file.html
      const revalidate = html || file.url.startsWith('/pwa/')
      const body = yield* Effect.promise(() => Bun.file(file.path).bytes())
      const response = HttpServerResponse.uint8Array(body, {
        headers: {
          'content-type': file.mime,
          'cache-control': revalidate ? 'no-cache' : 'public, max-age=31536000, immutable',
        },
      })
      if (html) {
        for (const path of ['/', '/settings', '/waitlist'] as const)
          yield* router.add('GET', path, response)
      } else yield* router.add('GET', file.url, response)
    }
  }),
).pipe(
  Layer.provide(
    HttpRouter.middleware(
      Effect.gen(function* () {
        const platform = yield* HttpPlatform.HttpPlatform
        const compress = HttpMiddleware.compression({ levels: { br: 5 } })
        return (effect) =>
          compress(effect).pipe(Effect.provideService(HttpPlatform.HttpPlatform, platform))
      }),
    ).layer,
  ),
)
