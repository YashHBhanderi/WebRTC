// The example talks to SpreeWe through its own origin: /api → backend REST, /socket.io → backend realtime.
// Point at another backend with SPREEWE_BACKEND=https://your-spreewe-api npm start
const BACKEND = process.env.SPREEWE_BACKEND || 'http://127.0.0.1:8000';
module.exports = [
  { context: ['/api'], target: BACKEND, secure: BACKEND.startsWith('https://'), changeOrigin: true, pathRewrite: { '^/api': '' } },
  { context: ['/socket.io'], target: BACKEND, secure: BACKEND.startsWith('https://'), changeOrigin: true, ws: true },
];
