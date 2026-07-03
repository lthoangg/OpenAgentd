// Global test setup — registers Happy DOM so React components can render.
import { mock, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Stub every material-icon-theme SVG `?url` import so Bun's module loader
// doesn't crash on them (Bun doesn't run Vite transforms). Each stub returns a
// predictable string that encodes the icon name — FileTypeIcon.test.tsx asserts
// on these strings, and all other tests just need a non-null value.
const SVG_ICONS = [
  'file', 'console', 'css', 'database', 'docker', 'git', 'go', 'html',
  'image', 'javascript', 'json', 'makefile', 'markdown', 'pdf', 'python',
  'react', 'react_ts', 'rust', 'sass', 'settings', 'toml', 'typescript',
  'xml', 'yaml', 'folder', 'folder-open',
]
for (const name of SVG_ICONS) {
  mock.module(`material-icon-theme/icons/${name}.svg?url`, () => ({
    default: `stub:${name}.svg`,
  }))
}

// Stub TerminalView globally: it renders xterm DOM owned by the terminal
// store. Tests that need terminal behaviour use TerminalKeyBar directly,
// drive useTerminalStore, or mock the WS layer (@/api/terminal).
mock.module("@/components/Terminal/TerminalView", () => ({
  TerminalView: () => null,
}))

// Stub the xterm construction module globally: @xterm/xterm ships a CSS
// import Bun's test loader can't process. useTerminalStore (imported by
// panels app-wide) pulls this in transitively. Store tests override this
// with their own instrumented mock.
mock.module("@/components/Terminal/xterm-instance", () => ({
  createXterm: () => ({
    term: {
      write: () => {},
      dispose: () => {},
      focus: () => {},
      onData: () => {},
      open: () => {},
      options: {},
      rows: 24,
      cols: 80,
    },
    fit: { fit: () => {} },
  }),
}))

// Pass an explicit ``url`` so ``window.location.origin`` is a real origin
// instead of ``"null"`` (the about:blank default). This matters for any
// test that calls ``new URL("/api/x", window.location.origin)``,
// constructs a ``Request`` from a relative URL, or asserts on
// same-origin behaviour (e.g. auth interceptor, image lightbox).
GlobalRegistrator.register({ url: "http://localhost:5173/" });

// Clean up DOM after each test to prevent test interference
afterEach(() => {
  // Clear all children from body
  if (typeof document !== "undefined" && document.body) {
    document.body.innerHTML = "";
  }
});
