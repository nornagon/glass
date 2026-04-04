import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import wasm from 'vite-plugin-wasm'

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base = process.env.GITHUB_ACTIONS === 'true' && repoName ? `/${repoName}/` : '/'

export default defineConfig({
  base,
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
          pixi: ['pixi.js', 'pixi-viewport'],
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
