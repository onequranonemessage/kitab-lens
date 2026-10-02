import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

// The built site is served by the FastAPI server (server/app.py) as static
// files out of web/dist. During `npm run dev`, /api is proxied to that
// server. VITE_API_TARGET overrides the default port (8757) in case it's
// already taken, e.g. by the backend agent's own dev instance.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const apiTarget = env.VITE_API_TARGET || "http://127.0.0.1:8757"

  return {
    plugins: [react()],
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
    server: {
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  }
})
