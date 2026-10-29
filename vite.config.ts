import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Official GUI preset: one CJS bundle, Solid JSX and host-shared externals.
// https://opencode.ai/v2/docs/build/plugins/gui#build-the-bundle
export default defineConfig({
  plugins: [gui()],
  build: { emptyOutDir: false },
})
