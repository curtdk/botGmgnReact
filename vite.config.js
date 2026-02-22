import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('development'), // 确保开发模式
  },
  build: { 
    minify: false,       // 关闭压缩，保持源码可读性，支持精确断点
    sourcemap: true,     // 生成独立 .map 文件，Chrome 识别更佳
    outDir: 'dist',
    rollupOptions: {
      output: {
        // 保持文件名，辅助调试
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
  }
})
