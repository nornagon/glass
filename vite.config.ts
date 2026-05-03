import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import wasm from 'vite-plugin-wasm'

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base = process.env.GITHUB_ACTIONS === 'true' && repoName ? `/${repoName}/` : '/'
const buildVersion = process.env.BUILD_VERSION ?? ''
const resourceMemoryBudgetMb = Number(process.env.RESOURCE_MEMORY_BUDGET_MB)
const resourceMemoryBudgetBytes =
  Number.isFinite(resourceMemoryBudgetMb) && resourceMemoryBudgetMb > 0
    ? Math.floor(resourceMemoryBudgetMb * 1024 * 1024)
    : 0

export default defineConfig({
  base,
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
    __RESOURCE_MEMORY_BUDGET_BYTES__: JSON.stringify(resourceMemoryBudgetBytes),
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          automerge: [
            '@automerge/react',
            '@automerge/automerge-repo-storage-indexeddb',
            '@automerge/automerge-repo-network-broadcastchannel',
            '@automerge/automerge-repo-network-websocket',
          ],
        },
      },
    },
  },
  server: {
    host: true,
    allowedHosts: true,
  },
  plugins: [
    wasm(),
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,ico}'],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Glass Board Sandbox',
        short_name: 'Glass',
        description: 'A local-first tabletop sandbox for improvised multiplayer board games.',
        theme_color: '#c96b2c',
        background_color: '#f2ead9',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
})
