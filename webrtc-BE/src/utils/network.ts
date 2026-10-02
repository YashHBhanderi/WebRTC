// Load .env before reading config — this module is evaluated during server.ts imports.
import 'dotenv/config';
import os from 'os';
import crypto from 'crypto';
import dns from 'dns';
import net from 'net';
import type { types as msTypes } from 'mediasoup';

/**
 * Media / ICE configuration. Everything infrastructure-specific comes from env,
 * so the same build runs on a dev PC (LAN) and on a public cloud SFU.
 *
 * Browser A ──UDP (preferred) / ICE-TCP / TURN──▶ mediasoup (public IP) ──▶ Browser B
 */

export type IceTransportPolicy = 'all' | 'relay';

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface MediaConfig {
  isProduction: boolean;
  listenIp: string;
  announcedAddress: string;
  rtcPort: number;
  enableUdp: boolean;
  enableTcp: boolean;
  initialAvailableOutgoingBitrate: number;
  maxIncomingBitrate: number;
  maxOutgoingBitrate: number;
  keyFrameRequestDelayMs: number;
  logLevel: 'debug' | 'warn' | 'error' | 'none';
  debugStats: boolean;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret: string;
  turnUsername: string;
  turnCredential: string;
  turnCredentialTtlSec: number;
  iceTransportPolicy: IceTransportPolicy;
  /** TEST ONLY — see withTestTunnelCandidate(). */
  testTcpTunnelHost: string;
  testTcpTunnelPort: number;
}

const str = (name: string): string => process.env[name]?.trim() || '';

const bool = (name: string, fallback: boolean): boolean => {
  const raw = str(name).toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === 'true' || raw === '1' || raw === 'yes';
};

const int = (name: string, fallback: number): number => {
  const raw = str(name);
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid numeric value for ${name}: "${raw}"`);
  }
  return Math.floor(n);
};

const list = (name: string): string[] =>
  str(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) {
    return false;
  }
  return (
    p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254)
  );
}

function isRfc1918(ip: string): boolean {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

/** First RFC1918 IPv4 on this host (skips VPN/CGNAT/link-local) — dev fallback only. */
function detectLanIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = String(net.family);
      const v4 = family === 'IPv4' || family === '4';
      if (v4 && !net.internal && isRfc1918(net.address)) {
        return net.address;
      }
    }
  }
  return '';
}

function loadMediaConfig(): MediaConfig {
  const isProduction = str('NODE_ENV') === 'production';

  let announcedAddress = str('MEDIASOUP_ANNOUNCED_ADDRESS');
  if (!announcedAddress) {
    if (isProduction) {
      throw new Error(
        'MEDIASOUP_ANNOUNCED_ADDRESS is required in production (public IP or DNS name of the media server)'
      );
    }
    announcedAddress = detectLanIp() || '127.0.0.1';
    console.warn(
      `[media] MEDIASOUP_ANNOUNCED_ADDRESS not set — using ${announcedAddress} (LAN only; cross-network calls will not work)`
    );
  } else if (isProduction && isPrivateIpv4(announcedAddress)) {
    console.warn(
      `[media] MEDIASOUP_ANNOUNCED_ADDRESS=${announcedAddress} is a private IP — browsers outside this network cannot reach it`
    );
  }

  const logLevel = (str('MEDIASOUP_LOG_LEVEL') || 'warn') as MediaConfig['logLevel'];
  const policy = (str('ICE_TRANSPORT_POLICY') || 'all').toLowerCase();

  const cfg: MediaConfig = {
    isProduction,
    listenIp: str('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
    announcedAddress,
    rtcPort: int('MEDIASOUP_RTC_PORT', 40000),
    enableUdp: bool('MEDIASOUP_ENABLE_UDP', true),
    enableTcp: bool('MEDIASOUP_ENABLE_TCP', true),
    initialAvailableOutgoingBitrate: int('MEDIASOUP_INITIAL_OUTGOING_BITRATE', 1_000_000),
    maxIncomingBitrate: int('MEDIASOUP_MAX_INCOMING_BITRATE', 5_000_000),
    maxOutgoingBitrate: int('MEDIASOUP_MAX_OUTGOING_BITRATE', 0),
    keyFrameRequestDelayMs: int('MEDIASOUP_KEYFRAME_REQUEST_DELAY_MS', 500),
    logLevel: ['debug', 'warn', 'error', 'none'].includes(logLevel) ? logLevel : 'warn',
    debugStats: bool('MEDIA_DEBUG_STATS', false),
    stunUrls: list('STUN_URLS'),
    turnUrls: list('TURN_URLS'),
    turnSecret: str('TURN_SECRET'),
    turnUsername: str('TURN_USERNAME'),
    turnCredential: str('TURN_CREDENTIAL'),
    // Matches the 24h app JWT; clients also refresh creds on every ICE restart
    turnCredentialTtlSec: int('TURN_CREDENTIAL_TTL', 86400),
    iceTransportPolicy: policy === 'relay' ? 'relay' : 'all',
    testTcpTunnelHost: str('MEDIA_TEST_TCP_TUNNEL_HOST'),
    testTcpTunnelPort: int('MEDIA_TEST_TCP_TUNNEL_PORT', 0),
  };

  if (cfg.testTcpTunnelHost || cfg.testTcpTunnelPort) {
    if (isProduction) {
      throw new Error('MEDIA_TEST_TCP_TUNNEL_* is a test-only setting and is refused in production');
    }
    if (!cfg.testTcpTunnelHost || !cfg.testTcpTunnelPort || !cfg.enableTcp) {
      throw new Error(
        'MEDIA_TEST_TCP_TUNNEL_HOST and MEDIA_TEST_TCP_TUNNEL_PORT must both be set, with MEDIASOUP_ENABLE_TCP=true'
      );
    }
    console.warn(
      `[media] TEST ONLY: advertising TCP tunnel ${cfg.testTcpTunnelHost}:${cfg.testTcpTunnelPort} ` +
      'as a last-resort candidate. Expect high latency for clients that use it.'
    );
  }

  if (!cfg.enableUdp && !cfg.enableTcp) {
    throw new Error('At least one of MEDIASOUP_ENABLE_UDP / MEDIASOUP_ENABLE_TCP must be true');
  }
  if (cfg.turnUrls.length && !cfg.turnSecret && !(cfg.turnUsername && cfg.turnCredential)) {
    throw new Error('TURN_URLS is set but neither TURN_SECRET nor TURN_USERNAME/TURN_CREDENTIAL is configured');
  }
  if (cfg.iceTransportPolicy === 'relay' && !cfg.turnUrls.length) {
    throw new Error('ICE_TRANSPORT_POLICY=relay requires TURN_URLS');
  }

  return cfg;
}

export const mediaConfig: MediaConfig = loadMediaConfig();

/** Log the effective config without secrets. */
export function describeMediaConfig(): string {
  const c = mediaConfig;
  const protos = [c.enableUdp ? 'udp' : '', c.enableTcp ? 'tcp' : ''].filter(Boolean).join('+');
  const turnAuth = c.turnSecret ? 'ephemeral' : c.turnUsername ? 'static' : 'none';
  return (
    `listen=${c.listenIp}:${c.rtcPort}/${protos} announced=${c.announcedAddress} ` +
    `stun=${c.stunUrls.length} turn=${c.turnUrls.length}(${turnAuth}) policy=${c.iceTransportPolicy}`
  );
}

/**
 * ICE servers handed to an authenticated client.
 * With TURN_SECRET (coturn `use-auth-secret`), credentials are short-lived HMACs,
 * so the shared secret never leaves the server and leaked creds expire.
 */
export function getIceServers(userId: string): IceServerConfig[] {
  const c = mediaConfig;
  const servers: IceServerConfig[] = [];

  if (c.stunUrls.length) {
    servers.push({ urls: c.stunUrls });
  }

  if (c.turnUrls.length) {
    if (c.turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + c.turnCredentialTtlSec;
      const username = `${expiry}:${userId}`;
      const credential = crypto.createHmac('sha1', c.turnSecret).update(username).digest('base64');
      servers.push({ urls: c.turnUrls, username, credential });
    } else {
      servers.push({ urls: c.turnUrls, username: c.turnUsername, credential: c.turnCredential });
    }
  }

  return servers;
}

let tunnelIpCache: { ip: string; at: number } | null = null;

async function resolveTunnelIp(host: string): Promise<string> {
  if (net.isIP(host)) {
    return host;
  }
  if (tunnelIpCache && Date.now() - tunnelIpCache.at < 30_000) {
    return tunnelIpCache.ip;
  }
  const { address } = await dns.promises.lookup(host, { family: 4 });
  tunnelIpCache = { ip: address, at: Date.now() };
  return address;
}

/**
 * TEST ONLY (dev, no public media server): append a TCP tunnel endpoint, e.g. `ngrok tcp 40000`,
 * as the lowest-priority ICE candidate. Clients that can reach the real address (LAN/UDP)
 * still use it; only clients with no other path fall back to the tunnel.
 * mediasoup cannot announce a port different from the one it listens on, so the
 * candidate is added here. Refused in production by loadMediaConfig().
 */
export async function withTestTunnelCandidate(
  candidates: msTypes.IceCandidate[]
): Promise<msTypes.IceCandidate[]> {
  const { testTcpTunnelHost: host, testTcpTunnelPort: port } = mediaConfig;
  if (!host || !port) {
    return candidates;
  }
  try {
    const ip = await resolveTunnelIp(host);
    return [
      ...candidates,
      {
        foundation: 'testtcptunnel',
        priority: 1,
        ip,
        address: ip,
        protocol: 'tcp',
        port,
        type: 'host',
        tcpType: 'passive',
      },
    ];
  } catch (error) {
    console.warn(`[media] TEST tunnel host ${host} did not resolve — candidate skipped`, error);
    return candidates;
  }
}

export function getClientIceConfig(userId: string): {
  iceServers: IceServerConfig[];
  iceTransportPolicy: IceTransportPolicy;
} {
  return {
    iceServers: getIceServers(userId),
    iceTransportPolicy: mediaConfig.iceTransportPolicy,
  };
}
