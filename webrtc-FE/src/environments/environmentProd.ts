/**
 * Same-origin in production: the reverse proxy serving this bundle forwards
 * /api/* (prefix stripped) and /socket.io/* to the backend. No hostnames are
 * baked into the build, so moving servers is a proxy/DNS change, not a rebuild.
 */
export const environment = {
  production: true,
  apiUrl: '/api',
  socketUrl: '', // unused — app.module connects the socket to window.location.origin
  // Fallback only: the backend's value (GET /config, from its .env) is used when reachable
  s3BaseUrl: '',
  BASE_URL:
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : '',
};
