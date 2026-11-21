import { defineConfig } from 'vite'

// Relative base so the built site works under https://<user>.github.io/photo-vote/
// Two pages: the voting page (/) and the admin page (/admin/).
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        admin: 'admin/index.html',
      },
    },
  },
})
