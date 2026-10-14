export type PresenceKey = 'available' | 'busy' | 'incall' | 'dnd' | 'away' | 'offline';

/** Statuses the user can choose (server: presence.service USER_STATUSES). */
export type ChosenStatus = 'Available' | 'Busy' | 'Do not disturb' | 'Away' | 'Appear offline';

export const STATUS_OPTIONS: { value: ChosenStatus; key: PresenceKey; label: string }[] = [
  { value: 'Available', key: 'available', label: 'Available' },
  { value: 'Busy', key: 'busy', label: 'Busy' },
  { value: 'Do not disturb', key: 'dnd', label: 'Do not disturb' },
  { value: 'Away', key: 'away', label: 'Be right back / Away' },
  { value: 'Appear offline', key: 'offline', label: 'Appear offline' },
];

export interface PresenceFields {
  isOnline?: boolean;
  status?: string | null;
  autoAway?: boolean;
  statusMessage?: string | null;
  /** Live only (from user:presence): in a call or meeting right now */
  inCall?: boolean;
}

/** What to show for a user: not connected → Offline; otherwise the chosen status, Away when idle. */
export function presenceOf(user: PresenceFields | null | undefined): PresenceKey {
  if (!user || !user.isOnline || user.status === 'Appear offline') {
    return 'offline';
  }
  if (user.status === 'Do not disturb') {
    return 'dnd';
  }
  // Teams-style: being in a call shows "In a call" over Available / Busy / Away
  if (user.inCall) {
    return 'incall';
  }
  switch (user.status) {
    case 'Busy': return 'busy';
    case 'Away': return 'away';
    default: return user.autoAway ? 'away' : 'available';
  }
}

export const PRESENCE_LABEL: Record<PresenceKey, string> = {
  available: 'Available',
  busy: 'Busy',
  incall: 'In a call',
  dnd: 'Do not disturb',
  away: 'Away',
  offline: 'Offline',
};

/** Apply a `user:presence` payload to any user object. */
export function applyPresence(target: any, data: { isOnline?: boolean; status?: string; statusMessage?: string; autoAway?: boolean; lastSeen?: string | Date | null }): void {
  target.isOnline = !!data.isOnline;
  if (data.status !== undefined) target.status = data.status;
  if (data.statusMessage !== undefined) target.statusMessage = data.statusMessage;
  if (data.autoAway !== undefined) target.autoAway = data.autoAway;
  if ((data as any).inCall !== undefined) target.inCall = (data as any).inCall;
  if (data.lastSeen) target.lastSeen = data.lastSeen;
}
