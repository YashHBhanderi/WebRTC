/**
 * Shared styles for the SpreeWe components. Everything is scoped to the components (no global CSS) and
 * themed through CSS custom properties a host app can override on any ancestor, e.g.
 *   spw-chat-app { --spw-accent: #0b5cad; --spw-radius: 4px; }
 * Defaults follow the SpreeWe web app (slate brand, light blue accent).
 */
export const SPW_THEME = `
  :host {
    --spw-bg: #ffffff;
    --spw-surface: #f4f6f8;
    --spw-border: #d9dee3;
    --spw-text: #1f2a33;
    --spw-muted: #66737f;
    --spw-brand: #2c3a47;
    --spw-accent: #82b4dc;
    --spw-mine: #dcebf7;
    --spw-danger: #b3261e;
    --spw-radius: 8px;
    --spw-font: inherit;
    font-family: var(--spw-font);
    color: var(--spw-text);
    box-sizing: border-box;
  }
  :host *, :host *::before, :host *::after { box-sizing: inherit; }
  button { font: inherit; cursor: pointer; border-radius: var(--spw-radius); border: 1px solid var(--spw-border); background: var(--spw-bg); color: var(--spw-text); padding: 6px 10px; }
  button.primary { background: var(--spw-brand); border-color: var(--spw-brand); color: #fff; }
  button.danger { background: var(--spw-danger); border-color: var(--spw-danger); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  input, select, textarea { font: inherit; border: 1px solid var(--spw-border); border-radius: var(--spw-radius); padding: 6px 8px; background: var(--spw-bg); color: var(--spw-text); min-width: 0; }
  .muted { color: var(--spw-muted); }
  .error { color: var(--spw-danger); }
  @media (prefers-color-scheme: dark) {
    :host {
      --spw-bg: #151b21; --spw-surface: #1d252d; --spw-border: #2f3a44; --spw-text: #e3e8ec;
      --spw-muted: #93a1ad; --spw-brand: #c7d2d8; --spw-mine: #24384a;
    }
    button.primary { color: #151b21; }
  }
`;

/** Display name of a user-like object */
export const nameOf = (u: { name?: string; username?: string; email?: string } | null | undefined): string =>
  u?.name || u?.username || u?.email || 'User';
