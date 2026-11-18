/**
 * `setupServer` for Bun tests, with the same `listen` / `use` /
 * `resetHandlers` / `close` surface as `msw/node`.
 *
 * msw 3's `msw/node` intercepts `fetch` at the socket layer, which Bun's
 * `node:net` does not expose, so its mocks never answer and requests hit the
 * real network (oven-sh/bun#44916). This builds the same network from msw's
 * own parts with the fetch-level interceptor instead. Go back to
 * `msw/node` once that issue is fixed.
 */
import { FetchInterceptor } from '@mswjs/interceptors/fetch/web'
import { http, HttpResponse, type RequestHandler } from 'msw'
import { defineNetwork, InterceptorSource } from 'msw/experimental'

type SourceInterceptor = ConstructorParameters<typeof InterceptorSource>[0]['interceptors'][number]

/**
 * A request no handler answers fails as a network error instead of reaching
 * the real network: a test never opens a socket, and a passing run does not
 * print `ECONNREFUSED`. `listen({ onUnhandledFrame })` with 'error' or
 * 'bypass' leaves it out, for tests that assert on unhandled requests.
 */
const offline = http.all('*', () => HttpResponse.error())

export function setupServer(...handlers: RequestHandler[]) {
  // `fetch/web` is typed from the package's browser build and msw's
  // `Interceptor` from its Node build, so TypeScript sees two classes. At
  // runtime they are the same one.
  const fetchInterceptor = new FetchInterceptor() as unknown as SourceInterceptor
  let fallback: RequestHandler[] = [offline]
  const network = defineNetwork({
    sources: [new InterceptorSource({ interceptors: [fetchInterceptor] })],
    handlers: [...handlers, offline],
    context: { quiet: true },
  })
  return {
    listen(options: { onUnhandledFrame?: 'bypass' | 'warn' | 'error' } = {}) {
      const mode = options.onUnhandledFrame ?? 'warn'
      if (mode !== 'warn') {
        fallback = []
        network.resetHandlers(...handlers)
      }
      network.configure({ onUnhandledFrame: mode })
      void network.enable()
    },
    use: network.use.bind(network),
    resetHandlers(...next: RequestHandler[]) {
      network.resetHandlers(...(next.length ? [...next, ...fallback] : [...handlers, ...fallback]))
    },
    close() {
      void network.disable()
    },
  }
}
