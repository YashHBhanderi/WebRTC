import os from 'os';
import fs from 'fs';
import path from 'path';

/** 100.64.0.0/10 used by Headscale / Tailscale / many WireGuard meshes */
export function isMeshVpnIp(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) {
    return false;
  }
  return p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

export function isLanIp(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) {
    return false;
  }
  return (
    p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168)
  );
}

/** True for paths that are low-latency (mesh VPN or LAN). */
export function isLowLatencyMediaIp(ip: string): boolean {
  return isMeshVpnIp(ip) || isLanIp(ip) || ip === '127.0.0.1';
}

export function getMeshVpnIp(): string {
  const fromEnv = process.env.MEDIA_MESH_IP?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const entries = nets[name];
    if (!entries) {
      continue;
    }
    for (const net of entries) {
      const family = String(net.family);
      if ((family === 'IPv4' || family === '4') && !net.internal && isMeshVpnIp(net.address)) {
        return net.address;
      }
    }
  }

  return '';
}

export function getLanIp(): string {
  const fromEnv = process.env.MEDIA_SERVER_LAN_IP?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const entries = nets[name];
    if (!entries) {
      continue;
    }

    for (const net of entries) {
      const family = String(net.family);
      if ((family === 'IPv4' || family === '4') && !net.internal && !isMeshVpnIp(net.address)) {
        return net.address;
      }
    }
  }

  return '';
}

export function getPublicMediaHost(): string {
  if (process.env.MEDIA_ALLOW_TCP_TUNNEL === 'true') {
    return process.env.MEDIA_TUNNEL_HOST?.trim() || '';
  }
  return '';
}

export function getPublicMediaPort(): number | undefined {
  if (process.env.MEDIA_ALLOW_TCP_TUNNEL !== 'true') {
    return undefined;
  }
  const raw = process.env.MEDIA_TUNNEL_PORT?.trim();
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function getLocalRtcPort(): number {
  return Number(process.env.MEDIA_RTC_PORT || process.env.RTC_MIN_PORT || 40000);
}

export function getAnnouncedIp(): string {
  const mesh = getMeshVpnIp();
  if (process.env.MEDIA_USE_MESH !== 'false' && mesh) {
    return mesh;
  }

  const lan = getLanIp();
  if (lan) {
    return lan;
  }

  const fromEnv = process.env.MEDIA_SERVER_IP?.trim();
  if (fromEnv && fromEnv !== '127.0.0.1' && fromEnv !== 'localhost') {
    return fromEnv;
  }

  return '127.0.0.1';
}

/**
 * Only announce low-latency paths by default (mesh + LAN).
 * Optional high-latency TCP tunnel is opt-in via MEDIA_ALLOW_TCP_TUNNEL=true.
 */
export function getAnnouncedAddresses(): string[] {
  const mesh = getMeshVpnIp();
  const lan = getLanIp();
  const tunnel =
    process.env.MEDIA_ALLOW_TCP_TUNNEL === 'true'
      ? process.env.MEDIA_TUNNEL_HOST?.trim()
      : '';

  const ips = [mesh, lan, tunnel].filter(Boolean) as string[];

  if (mesh) {
    console.log(`mediasoup LOW-LATENCY path: mesh ${mesh} (UDP WireGuard)`);
  }
  if (lan) {
    console.log(`mediasoup LOW-LATENCY path: LAN ${lan}`);
  }
  if (tunnel) {
    console.warn(
      `mediasoup HIGH-LATENCY TCP tunnel enabled: ${tunnel} — expect lag on this path`
    );
  }
  if (!mesh && !lan) {
    console.warn('mediasoup: no mesh/LAN IP found — cross-network A/V will fail until Headscale is up');
  }

  return [...new Set(ips)];
}

type IceCandidateLike = {
  foundation?: string;
  priority?: number;
  ip?: string;
  address?: string;
  protocol?: string;
  port: number;
  type?: string;
  tcpType?: string | null;
  [key: string]: unknown;
};

/**
 * Advertise mesh/LAN/public UDP first.
 * TCP bore tunnel is last-resort only and must never win ICE (it causes 10s+ lag).
 */
export function rewriteIceCandidates<T extends IceCandidateLike>(candidates: T[]): T[] {
  const localPort = getLocalRtcPort();
  const mesh = getMeshVpnIp();
  const lan = getLanIp();
  const publicIp = process.env.MEDIA_SERVER_IP?.trim() || '';
  const allowTunnel = process.env.MEDIA_ALLOW_TCP_TUNNEL === 'true';
  const forceUdpOnly = process.env.MEDIA_PREFER_UDP === 'strict';
  const tunnelHost = allowTunnel ? process.env.MEDIA_TUNNEL_HOST?.trim() : '';
  // Inject TCP bore only as lowest-priority fallback (connectivity), never preferred
  const injectTunnel = allowTunnel && !forceUdpOnly && !!tunnelHost;
  const tunnelPort = getPublicMediaPort();

  // Keep only UDP on low-latency / public paths. Drop TCP host candidates.
  let rewritten = candidates.filter((c) => {
    const ip = String(c.ip || c.address || '');
    const proto = String(c.protocol || '').toLowerCase();
    if (proto !== 'udp') {
      return false;
    }
    return (
      isLowLatencyMediaIp(ip) ||
      (!!publicIp && ip === publicIp) ||
      (!!tunnelHost && ip === tunnelHost)
    );
  });

  rewritten = rewritten.map((c) => {
    const next = { ...c };
    const ip = String(next.ip || next.address || '');
    if (isMeshVpnIp(ip)) {
      next.priority = 2_126_000_000;
    } else if (isLanIp(ip)) {
      next.priority = 2_120_000_000;
    } else if (publicIp && ip === publicIp) {
      next.priority = 2_100_000_000;
    }
    return next;
  });

  const extras: T[] = [];
  const template = candidates.find((c) => String(c.protocol).toLowerCase() === 'udp') || candidates[0];

  const pushUnique = (ip: string, protocol: string, port: number, priority: number) => {
    const exists = [...rewritten, ...extras].some(
      (c) =>
        (c.ip === ip || c.address === ip) &&
        String(c.protocol).toLowerCase() === protocol &&
        c.port === port
    );
    if (exists || !template || !ip) {
      return;
    }
    extras.push({
      ...template,
      foundation: `ll-${ip}-${protocol}-${port}`,
      ip,
      address: ip,
      protocol,
      port,
      type: 'host',
      tcpType: protocol === 'tcp' ? 'passive' : undefined,
      priority,
    } as T);
  };

  for (const ip of [mesh, lan].filter(Boolean) as string[]) {
    pushUnique(ip, 'udp', localPort, isMeshVpnIp(ip) ? 2_126_000_000 : 2_120_000_000);
  }

  // Public WAN UDP often is NOT port-forwarded — keep it below the TCP tunnel
  // so ngrok/off-mesh clients fall through to bore instead of hanging on dead UDP.
  if (
    publicIp &&
    publicIp !== '127.0.0.1' &&
    publicIp !== 'localhost' &&
    !isLanIp(publicIp) &&
    !isMeshVpnIp(publicIp)
  ) {
    pushUnique(publicIp, 'udp', localPort, 500_000);
  }

  // TCP bore: below mesh/LAN, above broken public UDP — required for ngrok phones
  if (injectTunnel && tunnelHost && tunnelPort != null) {
    pushUnique(tunnelHost, 'tcp', tunnelPort, 1_800_000_000);
  }

  const all = [...rewritten, ...extras].sort(
    (a, b) => Number(b.priority || 0) - Number(a.priority || 0)
  );
  console.log(
    `mediasoup ICE: ${all
      .map((c) => `${c.ip || c.address}:${c.port}/${c.protocol}@${c.priority}`)
      .join(', ') || '(none)'}`
  );
  return all;
}

/** Public VPN join info for remote devices (Headscale + Tailscale client). */
export function getVpnJoinInfo(): {
  loginServer: string;
  authKey: string;
  meshIp: string;
  rtcPort: number;
} {
  const vpnDir = path.resolve(__dirname, '../../../vpn');
  let loginServer = '';
  let authKey = '';
  try {
    loginServer = fs.readFileSync(path.join(vpnDir, 'login-server.txt'), 'utf8').trim();
  } catch {
    loginServer = process.env.HEADSCALE_PUBLIC_URL?.trim() || '';
  }
  try {
    authKey = fs.readFileSync(path.join(vpnDir, 'authkey.txt'), 'utf8').trim();
  } catch {
    authKey = process.env.HEADSCALE_AUTHKEY?.trim() || '';
  }

  return {
    loginServer,
    authKey,
    meshIp: getMeshVpnIp() || process.env.MEDIA_MESH_IP?.trim() || '',
    rtcPort: getLocalRtcPort(),
  };
}
