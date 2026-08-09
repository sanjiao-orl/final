import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Tauri 壳前端：dev 固定 1420（src-tauri/tauri.conf.json 的 devUrl 指向这里）。
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Rust 编译产物目录：Windows 下监视会撞文件锁（EBUSY），排除掉
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
