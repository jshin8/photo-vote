import { defineConfig } from 'vite'

// Relative base so the built site works under https://<user>.github.io/photo-vote/
// Pages: voting (/), admin (/admin/), and a printable QR code (/qr/).
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        admin: 'admin/index.html',
        qr: 'qr/index.html',
      },
    },
  },
})
