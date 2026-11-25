// Latency between the web UI and the backend: every request is forwarded to
// TARGET after the same fixed delay, so a response takes one delay longer and
// requests still queue on the browser's own connection limit.
//   PORT=8796 TARGET=http://127.0.0.1:8794 bun scripts/perf/browser_proxy.mjs
// `PUT /__delay/<ms>` sets the delay and resets the count; `GET /__stats`
// answers `{delay, forwarded}`, which the measurement checks against what the
// browser sent. WebSocket upgrades are not forwarded.
const TARGET = process.env.TARGET
const PORT = Number(process.env.PORT)
if (!TARGET || !PORT) throw new Error("browser_proxy: set PORT and TARGET")
let delay = 0
let forwarded = 0
Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith("/__delay/")) {
      delay = Number(url.pathname.slice("/__delay/".length)) || 0
      forwarded = 0
      return Response.json({ delay })
    }
    if (url.pathname === "/__stats") return Response.json({ delay, forwarded })
    forwarded += 1
    if (delay) await Bun.sleep(delay)
    const headers = new Headers(req.headers)
    headers.set("host", new URL(TARGET).host)
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
    const res = await fetch(TARGET + url.pathname + url.search, { method: req.method, headers, body, redirect: "manual", decompress: false })
    return new Response(res.body, { status: res.status, headers: res.headers })
  },
})
