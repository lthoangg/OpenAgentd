import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import svgr from "vite-plugin-svgr"
import { defineConfig } from "vite"
import { visualizer } from "rollup-plugin-visualizer"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    svgr(),
    // Bundle analysis — opt-in only (`bun run build:analyze`), never part of
    // the default build. Emits an interactive treemap to web/dist/stats.html.
    ...(process.env.ANALYZE === "1"
      ? [visualizer({ filename: "dist/stats.html", gzipSize: true, brotliSize: true, template: "treemap" })]
      : []),
  ],
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
    rolldownOptions: {
      output: {
        // Rolldown-native chunk groups (the deprecated function-form
        // `manualChunks` shim captured shared helpers — e.g. react's
        // jsx-runtime — into the "markdown" group, which made every eager
        // chunk statically depend on the 720 kB markdown chunk and forced it
        // into the startup modulepreload set). Groups are matched by
        // priority; unmatched shared helpers stay with their importers.
        codeSplitting: {
          groups: [
            // React core — loaded first, cached longest.
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 100 },
            // Routing + query (always needed, changes with app versions).
            {
              name: "tanstack",
              test: /node_modules[\\/]@tanstack[\\/](react-router|router-|react-query|query-)/,
              priority: 90,
            },
            // Animation (framer-motion is large ~150 kB gz).
            { name: "motion", test: /node_modules[\\/]framer-motion[\\/]/, priority: 90 },
            // Syntax highlighting — separate from "markdown" because the app
            // shell statically imports highlight.js (ToolCall shell commands,
            // CodingFileViewerPanel); shared by the lazy markdown chunk.
            { name: "syntax", test: /node_modules[\\/](highlight\.js|lowlight)[\\/]/, priority: 85 },
            // Markdown remains behind LazyMarkdownBlock's dynamic import.
            // Do not force its dependency graph into a named group: Rolldown
            // can otherwise emit a vendor chunk that imports its own dynamic
            // entry, which crashes production WebViews during module init.
            // Icons (lucide ships many SVGs).
            { name: "icons", test: /node_modules[\\/]lucide-react[\\/]/, priority: 70 },
            // State + utilities (zustand, immer, zod, nuqs).
            {
              name: "state-utils",
              test: /node_modules[\\/](zustand|immer|zod|clsx|class-variance-authority|tailwind-merge|nuqs)[\\/]/,
              priority: 70,
            },
            // Tauri APIs — keep in one chunk so the static import from
            // use-tauri-drag does not land in the main index bundle.
            { name: "tauri", test: /node_modules[\\/]@tauri-apps[\\/]/, priority: 70 },
          ],
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
