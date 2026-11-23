/**
 * Active navigation icons (styles.scss, "Filled variant"). Rail items get `ti-fill` when active; the
 * filled font only has glyphs for some icons, so the font switch must happen only for those. Teams
 * (users-group) has no filled glyph: switching its font showed an unrelated character (U+FA21).
 * Runs against the real global stylesheet (angular.json test "styles").
 */
describe('Active navigation icons (ti-fill)', () => {
  const FILLED_FONT = 'tabler-icons-filled';
  // Every icon the navigation rail can show, and the other places that use ti-fill
  const WITH_FILLED_GLYPH: Record<string, string> = {
    bell: '',
    'message-circle': 'ﻏ',
    phone: '爫',
    calendar: 'ﬧ',
    folder: '',
    user: 'ﴙ',
    settings: '',
    'player-play': '',
    'player-pause': '',
    microphone: '️',
    circle: '',
  };
  const WITHOUT_FILLED_GLYPH = ['users-group', 'users', 'building'];

  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  function icon(name: string, active: boolean): HTMLElement {
    const el = document.createElement('i');
    el.className = `ti ti-${name}${active ? ' ti-fill' : ''}`;
    host.appendChild(el);
    return el;
  }

  it('keeps the outline font for an active Teams icon (no filled users-group glyph exists)', () => {
    for (const name of WITHOUT_FILLED_GLYPH) {
      const style = getComputedStyle(icon(name, true));
      expect(style.fontFamily).withContext(name).not.toContain(FILLED_FONT);
      // Drawn slightly heavier instead, so it still reads as selected next to filled icons
      expect(parseFloat(style.getPropertyValue('-webkit-text-stroke-width'))).withContext(name).toBeGreaterThan(0);
    }
  });

  it('switches icons that have a filled glyph to the filled font and that glyph', () => {
    for (const [name, glyph] of Object.entries(WITH_FILLED_GLYPH)) {
      const el = icon(name, true);
      expect(getComputedStyle(el).fontFamily).withContext(name).toContain(FILLED_FONT);
      expect(getComputedStyle(el, '::before').content).withContext(name).toBe(`"${glyph}"`);
      expect(parseFloat(getComputedStyle(el).getPropertyValue('-webkit-text-stroke-width'))).withContext(name).toBe(0);
    }
  });

  it('leaves inactive icons alone', () => {
    for (const name of [...Object.keys(WITH_FILLED_GLYPH), ...WITHOUT_FILLED_GLYPH]) {
      expect(getComputedStyle(icon(name, false)).fontFamily).withContext(name).not.toContain(FILLED_FONT);
    }
  });
});
