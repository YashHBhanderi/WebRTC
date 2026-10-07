/**
 * Dev is served over HTTPS (npm run dev).
 * API/socket use same origin → Angular proxy → http://127.0.0.1:8000
 * so camera/mic work and APIs are not blocked as mixed content.
 */
export const environment = {
  production: false,
  apiUrl: '/api',
  socketUrl: '', // same origin; /socket.io is proxied to backend
  // Fallback only: the backend's value (GET /config, from its .env) is used when reachable
  s3BaseUrl: 'https://webrtc-test-dev-128d3567472b196e1045d829b3.s3.ap-south-1.amazonaws.com',
  BASE_URL:
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://192.168.3.75:4200',
};
