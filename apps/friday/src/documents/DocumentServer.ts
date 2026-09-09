import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import {
  DocumentNotFoundBody,
  documentNotFoundHeaders,
  documentResponseHeaders,
  renderDocumentBody,
  renderDocumentPage,
} from './DocumentRendering.ts'
import { Documents } from './Documents.ts'

export interface ServedDocumentResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

const notFound = (): ServedDocumentResponse => ({
  status: 404,
  headers: documentNotFoundHeaders(),
  body: DocumentNotFoundBody,
})

const requestKey = (
  rawUrl: string,
): { readonly key: string; readonly auth: string | null } | null => {
  if (!URL.canParse(rawUrl)) return null
  const parsed = new URL(rawUrl)
  const prefix = '/files/'
  if (!parsed.pathname.startsWith(prefix)) return null
  const encoded = parsed.pathname.slice(prefix.length)
  if (encoded.length === 0 || encoded.includes('/')) return null
  // Malformed percent-encoding would throw in decodeURIComponent.
  if (encoded.includes('%') && !/^([^%]|%[0-9A-Fa-f]{2})*$/.test(encoded)) return null
  const key = decodeURIComponent(encoded)
  if (key.length === 0) return null
  return { key, auth: parsed.searchParams.get('auth') }
}

/**
 * Answers one document request. Unknown routes, methods other than GET,
 * missing documents, and missing or wrong credentials all resolve to the same
 * 404 response. The supplied credential never reaches logs or errors.
 */
export const serveDocumentRequest = Effect.fn('DocumentServer.serveRequest')(function* (
  method: string,
  rawUrl: string,
) {
  const documents = yield* Documents
  if (method !== 'GET') return notFound()
  const request = requestKey(rawUrl)
  if (request === null) return notFound()
  const found = yield* documents.verify(request.key, request.auth)
  if (Option.isNone(found)) return notFound()
  const body = renderDocumentBody(found.value.content, found.value.metadata.format)
  return {
    status: 200,
    headers: documentResponseHeaders(),
    body: renderDocumentPage(body),
  } satisfies ServedDocumentResponse
})

/**
 * Serves private document URLs on the configured loopback interface. A
 * reverse proxy owns TLS and forwards to this listener; the process never
 * exposes an index or an upload endpoint.
 */
export const startDocumentServer = Effect.fn('DocumentServer.start')(function* () {
  const documents = yield* Documents
  const config = yield* documents.getConfig()
  const context = yield* Effect.context()
  const runPromise = Effect.runPromiseWith(context)
  const server = Bun.serve({
    hostname: config.listenHost,
    port: config.listenPort,
    fetch: (request) =>
      runPromise(
        serveDocumentRequest(request.method, request.url).pipe(
          Effect.provideService(Documents, documents),
        ),
      ).then(
        (response) =>
          new Response(response.body, { status: response.status, headers: response.headers }),
      ),
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop()))
  yield* Effect.logInfo('documents.serving').pipe(
    Effect.annotateLogs({
      component: 'documents',
      host: config.listenHost,
      port: config.listenPort,
    }),
  )
})
