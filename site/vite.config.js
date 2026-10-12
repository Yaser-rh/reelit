import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/reelit/',
  server: {
    port: 5173,
    host: true
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        // Limited strictly to app shell assets only
        globPatterns: ['**/*.{js,css,html,ico,png,svg}']
      },
      manifest: {
        name: 'Reelit',
        short_name: 'Reelit',
        description: 'Personal TikTok-style vertical video and reels feed for Reddit',
        start_url: '/reelit/',
        scope: '/reelit/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#000000',
        background_color: '#000000',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ]
});
