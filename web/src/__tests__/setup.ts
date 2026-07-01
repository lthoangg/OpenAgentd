// Global test setup — registers Happy DOM so React components can render.
import { mock, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Stub FileTypeIcon so its `?url` SVG imports don't crash Bun's module loader
// (Bun doesn't run Vite, so raw SVG files have no `default` export). Tests
// never assert on icon appearance, so a no-op component is correct.
mock.module("@/components/FileTypeIcon", () => ({
  FileTypeIcon: () => null,
}));



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
