import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Keep browser API calls same-origin. Vite forwards /api and /preview to the
// Node backend, which prevents the UI from accidentally talking to an old
// service on port 3002 and receiving an HTML page where JSON was expected.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3002',
        changeOrigin: true,
        secure: false,
      },
      '/preview': {
        target: 'http://127.0.0.1:3002',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
