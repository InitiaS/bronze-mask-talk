import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    emptyOutDir: false,
    rollupOptions: {
      // 三个入口：粒子重构 / 戴面具 / 开口讲解
      input: {
        main: resolve(process.cwd(), 'index.html'),
        face: resolve(process.cwd(), 'face.html'),
        talk: resolve(process.cwd(), 'talk.html')
      }
    }
  }
})
