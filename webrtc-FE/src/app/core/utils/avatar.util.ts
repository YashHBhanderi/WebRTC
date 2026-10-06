/**
 * Generated avatar for people and groups without a picture: up to two initials on a colour
 * derived from the name, so the same name always gets the same colour everywhere in the app.
 */
export interface AvatarColors {
  bg: string;
  fg: string;
}

// Soft backgrounds with dark text (WCAG AA contrast for the initials)
const PALETTE: AvatarColors[] = [
  { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#dcfce7', fg: '#166534' },
  { bg: '#fef3c7', fg: '#92400e' },
  { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#ede9fe', fg: '#5b21b6' },
  { bg: '#ffedd5', fg: '#9a3412' },
  { bg: '#cffafe', fg: '#155e75' },
  { bg: '#fee2e2', fg: '#991b1b' },
  { bg: '#e0e7ff', fg: '#3730a3' },
  { bg: '#ccfbf1', fg: '#115e59' },
];

/** "Alice Johnson" → "AJ", "bob" → "B", "" → "?" (letters/digits of any script). */
export function avatarInitials(name: string | null | undefined): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  const first = (w: string | undefined) => (w ? Array.from(w).find((ch) => /[\p{L}\p{N}]/u.test(ch)) || '' : '');
  const letters = words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0]);
  return letters.toUpperCase() || '?';
}

export function avatarColors(name: string | null | undefined): AvatarColors {
  const key = (name || '').trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
