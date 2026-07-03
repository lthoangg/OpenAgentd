import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import svgr from "vite-plugin-svgr"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), svgr()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
        changeOrigin: true,
        // Forward WebSocket upgrades too (terminal PTY at /api/terminal/ws).
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React core — loaded first, cached longest
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/") || id.includes("node_modules/scheduler/")) {
            return "react"
          }
          // Routing + query (always needed, changes with app versions)
          if (
            id.includes("node_modules/@tanstack/react-router") ||
            id.includes("node_modules/@tanstack/router-") ||
            id.includes("node_modules/@tanstack/react-query") ||
            id.includes("node_modules/@tanstack/query-")
          ) {
            return "tanstack"
          }
          // Animation (framer-motion is large ~150 kB gz)
          if (id.includes("node_modules/framer-motion")) {
            return "motion"
          }
          // Markdown rendering (react-markdown + remark + rehype chain) — lazy loaded on demand
          if (
            id.includes("node_modules/react-markdown") ||
            id.includes("node_modules/remark") ||
            id.includes("node_modules/rehype") ||
            id.includes("node_modules/unified") ||
            id.includes("node_modules/vfile") ||
            id.includes("node_modules/hast") ||
            id.includes("node_modules/mdast") ||
            id.includes("node_modules/micromark") ||
            id.includes("node_modules/unist") ||
            id.includes("node_modules/property-information") ||
            id.includes("node_modules/lowlight") ||
            id.includes("node_modules/highlight.js")
          ) {
            return "markdown"
          }
          // Icons (lucide ships many SVGs — lazy chunk)
          if (id.includes("node_modules/lucide-react")) {
            return "icons"
          }
          // State + utilities (zustand, immer, zod, clsx, cva, tailwind-merge)
          if (
            id.includes("node_modules/zustand") ||
            id.includes("node_modules/immer") ||
            id.includes("node_modules/zod") ||
            id.includes("node_modules/clsx") ||
            id.includes("node_modules/class-variance-authority") ||
            id.includes("node_modules/tailwind-merge") ||
            id.includes("node_modules/nuqs")
          ) {
            return "state-utils"
          }
          // UI primitives (@base-ui/react, radix, shadcn wrappers)
          if (id.includes("node_modules/@base-ui/react") || id.includes("node_modules/@radix-ui")) {
            return "ui"
          }
          // Dev tools (query devtools, router devtools) — stripped in prod but split anyway
          if (
            id.includes("node_modules/@tanstack/react-query-devtools") ||
            id.includes("node_modules/@tanstack/router-devtools")
          ) {
            return "devtools"
          }
          // Tauri APIs — keep in one chunk so the static import from
          // use-tauri-drag does not land in the main index bundle.
          if (
            id.includes("node_modules/@tauri-apps/") ||
            id.includes("node_modules/@tauri-apps/api") ||
            id.includes("node_modules/@tauri-apps/plugin-")
          ) {
            return "tauri"
          }
        },
      },
    },
    // index chunk contains the full app shell (TeamChatView, CodingSidebar,
    // Sidebar, InputBar, stores) which must be eagerly available on first
    // paint. Markdown/Tauri/icons/motion are split into separate chunks.
    // Route-level lazy loading is intentionally avoided to prevent Suspense
    // waterfalls on tauri:// navigation. 1100 kB reflects the real baseline.
    chunkSizeWarningLimit: 1100,
  },
})
