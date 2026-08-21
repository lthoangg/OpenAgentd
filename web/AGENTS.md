# Web Frontend Guide

This Bun/Vite React application is shared by browsers and both Tauri shells.
It uses strict TypeScript, Tailwind, TanStack Router/Query, and Zustand. Tests
run with Bun, Happy DOM, and Testing Library.

## Development

From `web/`:

```bash
bun install --frozen-lockfile
bun dev
bun run lint
bun run typecheck
bunx tsc -p tsconfig.test.json --noEmit
bun run test
bun run test:file src/__tests__/path/to/file.test.tsx
bun run build
```

`bun run build` includes the TypeScript build, Vite production bundle, and the
chunk-cycle guard. The root `make build-web` performs a frozen install before
building packaging assets. Do not edit `web/dist/` directly.

Before finishing frontend changes, run `make verify-web` from the repository
root. The `web/Makefile` is a convenience wrapper for package scripts; the root
Makefile owns the pre-merge contract.

## Architecture

- `src/api/` owns backend URLs, auth injection, request/response handling, and
  SSE parsing.
- `src/queries/` owns TanStack Query hooks/mutations and cache updates for
  server state.
- `src/stores/` owns client state and streamed session/team state.
- `src/routes/` contains pages; register and validate route/search state in
  `src/router.ts`.
- `src/components/` owns shared and feature UI; `src/hooks/` owns reusable
  behavior. Prefer colocated feature hooks/modules before expanding a large
  component.

Use static ESM imports and the `@/` alias for application modules. Keep
same-origin `/api` desktop-token injection intact; do not attach native access
tokens to arbitrary remote URLs.

## UI constraints

- Read root `DESIGN.md` and reuse tokens from `src/index.css` and existing
  primitives before adding colors, spacing, type, radius, elevation, or motion.
- Build the shared UI mobile-first. Gate platform behavior through existing
  `useIsMobile()` / `usePlatform()` hooks, account for safe areas and desktop
  chrome, and provide touch equivalents for hover/right-click behavior.
- Manually inspect narrow and wide layouts for visual changes; this is not
  covered by `make verify-web`.
- `src/components/ui/` contains intentionally dependency-free primitives. Do
  not introduce shadcn/Base UI/CVA/clsx/tailwind-merge for those primitives;
  follow the local maps and class helpers.
- Route mobile drawer gestures through the shared edge-swipe controller rather
  than adding competing component-local touch handlers.

Backend API/SSE changes require matching frontend client/store tests and both
`make verify-backend` and `make verify-web`.
