import { defineConfig } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const staticOutDir = resolve(__dirname, "../internal/app/static");

export default defineConfig({
  plugins: [
    {
      name: "keep-go-embed-static-placeholder",
      writeBundle() {
        mkdirSync(staticOutDir, { recursive: true });
        writeFileSync(resolve(staticOutDir, ".gitkeep"), "\n");
      }
    }
  ],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080"
    }
  },
  build: {
    outDir: staticOutDir,
    emptyOutDir: true
  },
  optimizeDeps: {
    exclude: ["vscode"]
  }
});
