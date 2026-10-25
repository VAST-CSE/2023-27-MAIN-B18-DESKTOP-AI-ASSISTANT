import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// electron-vite already knows the layout:
//   src/main/index.ts      -> out/main/index.js
//   src/preload/index.ts   -> out/preload/index.js
//   src/renderer/index.html -> out/renderer/
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {}
})
