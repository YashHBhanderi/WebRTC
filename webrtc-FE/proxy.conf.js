// Local backend by default; point at a cloud backend with BACKEND_URL=https://your-domain npm run dev
const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
// Verify TLS when proxying to a real (https) backend
const SECURE = BACKEND.startsWith('https://');

/**
 * Proxy both `/api/*` (preferred) and bare backend routes.
 * Bare routes cover older clients / cached bundles that omit the `/api` prefix.
 */
module.exports = [
  {
    context: ['/api'],
    target: BACKEND,
    secure: SECURE,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    logLevel: 'warn',
    timeout: 60000,
    proxyTimeout: 60000,
  },
  {
    context: [
      '/conversations',
      '/groupConversations',
      '/messages',
      '/web',
      '/jitsi-room',
      '/uploads',
      '/socket.io',
    ],
    target: BACKEND,
    secure: SECURE,
    changeOrigin: true,
    ws: true,
    logLevel: 'warn',
    timeout: 60000,
    proxyTimeout: 60000,
  },
];
