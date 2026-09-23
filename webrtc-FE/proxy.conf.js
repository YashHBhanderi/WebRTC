const BACKEND = 'http://127.0.0.1:8000';

/**
 * Proxy both `/api/*` (preferred) and bare backend routes.
 * Bare routes cover older clients / cached bundles that omit the `/api` prefix.
 */
module.exports = [
  {
    context: ['/api'],
    target: BACKEND,
    secure: false,
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
      '/media',
      '/jitsi-room',
      '/uploads',
      '/socket.io',
    ],
    target: BACKEND,
    secure: false,
    changeOrigin: true,
    ws: true,
    logLevel: 'warn',
    timeout: 60000,
    proxyTimeout: 60000,
  },
];
