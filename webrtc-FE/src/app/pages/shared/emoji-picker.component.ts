import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ComponentRef,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  Output,
  ViewChild,
  ViewContainerRef,
  ViewEncapsulation,
} from '@angular/core';
import type { PickerComponent } from '@ctrl/ngx-emoji-mart';

type Skin = 1 | 2 | 3 | 4 | 5 | 6;

const PICKER_WIDTH = 340;
const PICKER_HEIGHT = 420;
const MIN_HEIGHT = 260;
const GAP = 8;
const MOBILE_MAX = 600;
const RECENT_KEY = 'app.emoji.recent';
const SKIN_KEY = 'app.emoji.skin';
const RECENT_MAX = 24;

/** Swatch colours for the skin-tone menu (default yellow + Fitzpatrick 1-2 … 6). */
const SKINS: { skin: Skin; label: string; color: string }[] = [
  { skin: 1, label: 'Default', color: '#ffc93a' },
  { skin: 2, label: 'Light', color: '#f8dbba' },
  { skin: 3, label: 'Medium-light', color: '#e2bb96' },
  { skin: 4, label: 'Medium', color: '#c08b63' },
  { skin: 5, label: 'Medium-dark', color: '#8f5d3c' },
  { skin: 6, label: 'Dark', color: '#5c4033' },
];

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / storage full: recents just won't persist
  }
}

/**
 * Emoji picker built on the already-installed, open-source @ctrl/ngx-emoji-mart (MIT):
 * search, category tabs, "Recently used" (true recency, stored per browser) and skin tones.
 * Emoji are drawn with the app's emoji font (Noto Color Emoji, see styles.scss), so they look
 * the same on every OS. Opens above or below its anchor, always inside the viewport;
 * bottom sheet on phones. Picking an emoji emits it immediately.
 */
@Component({
  selector: 'app-emoji-picker',
  template: `
    <div class="ep-backdrop" (click)="closed.emit()"></div>
    <div
      class="ep"
      [class.ep--sheet]="sheet"
      [style.left.px]="sheet ? null : left"
      [style.top.px]="sheet ? null : top"
      [style.height.px]="height"
      role="dialog"
      aria-label="Emoji picker"
    >
      <div class="ep__skin">
        <button
          type="button"
          class="ep__skin-btn"
          (click)="skinMenuOpen = !skinMenuOpen"
          [attr.aria-expanded]="skinMenuOpen"
          aria-label="Skin tone"
          title="Skin tone"
        >
          <span class="ep__swatch" [style.background]="currentSkin.color"></span>
        </button>
        <div class="ep__skin-menu" *ngIf="skinMenuOpen" role="menu" aria-label="Skin tone">
          <button
            *ngFor="let s of skins"
            type="button"
            role="menuitemradio"
            class="ep__skin-option"
            [class.is-active]="s.skin === skin"
            [attr.aria-checked]="s.skin === skin"
            [attr.aria-label]="s.label"
            [title]="s.label"
            (click)="setSkin(s.skin)"
          >
            <span class="ep__swatch" [style.background]="s.color"></span>
          </button>
        </div>
      </div>
      <div class="ep__loading" *ngIf="loading">
        <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
      </div>
      <ng-container #host></ng-container>
    </div>
  `,
  styles: [`
    app-emoji-picker { position: fixed; inset: 0; z-index: 1065; }
    app-emoji-picker .ep-backdrop { position: absolute; inset: 0; }
    app-emoji-picker .ep {
      position: absolute;
      display: flex;
      flex-direction: column;
      width: ${PICKER_WIDTH}px;
      max-width: calc(100vw - ${GAP * 2}px);
      border: 1px solid var(--app-border, #e4e7ec);
      border-radius: 14px;
      background: var(--app-surface, #fff);
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.22);
      overflow: hidden;
      animation: ep-in 0.12s ease-out;
    }
    app-emoji-picker .ep--sheet {
      left: 0; right: 0; bottom: 0;
      width: 100%; max-width: none;
      border-radius: 16px 16px 0 0;
      padding-bottom: env(safe-area-inset-bottom);
    }
    @keyframes ep-in { from { opacity: 0; transform: translateY(4px); } }
    @media (prefers-reduced-motion: reduce) { app-emoji-picker .ep { animation: none; } }
    app-emoji-picker .ep__loading { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--app-muted, #64748b); }

    /* Skin tone button sits at the right end of the search row */
    app-emoji-picker .ep__skin { position: absolute; top: 10px; right: 10px; z-index: 5; }
    app-emoji-picker .ep__skin-btn,
    app-emoji-picker .ep__skin-option {
      width: 34px; height: 34px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: 10px; background: transparent;
    }
    app-emoji-picker .ep__skin-btn:hover, app-emoji-picker .ep__skin-option:hover { background: var(--app-hover, #f2f4f7); }
    app-emoji-picker .ep__skin-btn:focus-visible, app-emoji-picker .ep__skin-option:focus-visible { outline: 2px solid var(--app-brand, #2563eb); }
    app-emoji-picker .ep__skin-option.is-active { background: var(--app-active, #e8effc); }
    app-emoji-picker .ep__swatch { width: 18px; height: 18px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
    app-emoji-picker .ep__skin-menu {
      position: absolute; top: 38px; right: 0;
      display: flex; flex-direction: column; gap: 2px; padding: 4px;
      border: 1px solid var(--app-border, #e4e7ec); border-radius: 12px;
      background: var(--app-surface, #fff); box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
    }

    /*
     * ---- emoji-mart, fully styled here (no dependency on the library's global picker.css).
     * Layout: search → scrolling grid (sticky category title) → category tabs at the bottom.
     */
    app-emoji-picker emoji-mart { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    app-emoji-picker .emoji-mart,
    app-emoji-picker .emoji-mart * { box-sizing: border-box; line-height: 1.15; }
    app-emoji-picker .emoji-mart {
      display: flex !important;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      width: 100% !important;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--app-text, #111827);
      font-family: var(--app-font);
      font-size: 16px;
    }
    app-emoji-picker .emoji-mart-sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); border: 0;
    }

    /* Search (top) */
    app-emoji-picker .emoji-mart-search { order: 1; flex: none; position: relative; margin: 0; padding: 10px 50px 8px 10px; }
    app-emoji-picker .emoji-mart-search input {
      display: block;
      width: 100%;
      height: 36px;
      padding: 6px 34px 6px 12px;
      border: 1px solid transparent;
      border-radius: 10px;
      outline: 0;
      background: var(--app-input, #f0f2f5);
      color: var(--app-text, #111827);
      font: inherit;
      font-size: 0.9rem;
      -webkit-appearance: none;
      appearance: none;
    }
    app-emoji-picker .emoji-mart-search input::-webkit-search-decoration { -webkit-appearance: none; }
    app-emoji-picker .emoji-mart-search input::-webkit-search-cancel-button { -webkit-appearance: none; }
    app-emoji-picker .emoji-mart-search input::placeholder { color: var(--app-muted, #6b7280); }
    app-emoji-picker .emoji-mart-search input:focus { border-color: var(--app-brand, #2563eb); background: var(--app-surface, #fff); }
    app-emoji-picker .emoji-mart-search-icon {
      position: absolute; top: 18px; right: 58px; z-index: 2;
      display: flex; align-items: center; padding: 2px 4px;
      border: 0; background: none; color: var(--app-muted, #6b7280); cursor: pointer;
    }
    app-emoji-picker .emoji-mart-search-icon svg { fill: currentColor; width: 13px; height: 13px; }

    /* Grid (middle, scrolls) */
    app-emoji-picker .emoji-mart-scroll {
      order: 2; flex: 1; min-height: 0; height: auto;
      padding: 0 8px 8px; overflow-y: auto; overscroll-behavior: contain;
    }
    app-emoji-picker .emoji-mart-category { position: relative; }
    app-emoji-picker .emoji-mart-category-label { position: sticky; top: 0; z-index: 2; }
    app-emoji-picker .emoji-mart-category-label span {
      display: block;
      width: 100%;
      padding: 8px 4px 6px;
      background: var(--app-surface, #fff) !important;
      color: var(--app-text, #111827) !important;
      font-size: 0.82rem;
      font-weight: 600;
    }
    app-emoji-picker .emoji-mart-emoji {
      position: relative;
      display: inline-block;
      margin: 0;
      padding: 6px;
      border: 0;
      border-radius: 10px;
      background: none;
      box-shadow: none;
      font-size: 0;
      cursor: pointer;
    }
    app-emoji-picker .emoji-mart-emoji span { position: relative; z-index: 1; display: inline-block; text-align: center; cursor: pointer !important; }
    app-emoji-picker .emoji-mart-emoji-native {
      font-family: 'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;
    }
    app-emoji-picker .emoji-mart-category .emoji-mart-emoji:hover:before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: 0;
      border-radius: 10px;
      background-color: var(--app-hover-strong, #e6e9ee);
    }
    app-emoji-picker .emoji-mart-emoji:focus-visible { outline: 2px solid var(--app-brand, #2563eb); }
    app-emoji-picker .emoji-mart-no-results { padding-top: 40px; text-align: center; font-size: 14px; color: var(--app-muted, #6b7280); }
    app-emoji-picker .emoji-mart-no-results .emoji-mart-category-label { display: none; }
    app-emoji-picker .emoji-mart-no-results .emoji-mart-emoji:hover:before { content: none; }

    /* Category tabs (bottom) */
    app-emoji-picker .emoji-mart-bar {
      order: 3; flex: none;
      border: 0 !important; border-top: 1px solid var(--app-border, #e4e7ec) !important; border-radius: 0 !important;
    }
    app-emoji-picker .emoji-mart-anchors {
      display: flex; flex-direction: row; justify-content: space-between;
      padding: 2px 4px; line-height: 0;
    }
    app-emoji-picker .emoji-mart-anchor {
      position: relative; display: block; flex: 1 1 auto;
      margin: 0; padding: 9px 2px; overflow: hidden;
      border: 0; border-radius: 8px; background: none; box-shadow: none;
      color: var(--app-icon, #54656f); text-align: center; cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease;
    }
    app-emoji-picker .emoji-mart-anchor:hover { background: var(--app-hover, #f2f4f7); color: var(--app-text, #111827); }
    app-emoji-picker .emoji-mart-anchor-selected { background: var(--app-active, #e8effc); color: var(--app-brand, #2563eb) !important; }
    app-emoji-picker .emoji-mart-anchor-bar { display: none; }
    app-emoji-picker .emoji-mart-anchors svg { display: inline-block; width: 18px; height: 18px; fill: currentColor; }
  `],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmojiPickerComponent implements AfterViewInit, OnDestroy {
  /** Element the picker opens next to (the button that toggled it). */
  @Input() anchor: HTMLElement | null = null;
  @Output() picked = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();

  @ViewChild('host', { read: ViewContainerRef }) host!: ViewContainerRef;

  readonly skins = SKINS;
  loading = true;
  sheet = false;
  left = GAP;
  top = GAP;
  height = PICKER_HEIGHT;
  skin: Skin = readStorage<Skin>(SKIN_KEY, 1);
  skinMenuOpen = false;

  private pickerRef: ComponentRef<PickerComponent> | null = null;
  private destroyed = false;

  constructor(private cdr: ChangeDetectorRef) {
    if (!SKINS.some((s) => s.skin === this.skin)) {
      this.skin = 1;
    }
  }

  get currentSkin() {
    return SKINS.find((s) => s.skin === this.skin) || SKINS[0];
  }

  async ngAfterViewInit(): Promise<void> {
    this.position();
    const { PickerComponent } = await import('@ctrl/ngx-emoji-mart');
    if (this.destroyed) {
      return;
    }
    const ref = this.host.createComponent(PickerComponent);
    ref.setInput('isNative', true);
    // The library follows the OS colour scheme by default; the app itself is light-only
    ref.setInput('darkMode', false);
    ref.setInput('showPreview', false);
    ref.setInput('perLine', 8);
    ref.setInput('emojiSize', 24);
    ref.setInput('color', '#2563eb');
    ref.setInput('autoFocus', !this.sheet);
    ref.setInput('title', '');
    ref.setInput('skin', this.skin);
    ref.setInput('totalFrequentLines', 3);
    ref.setInput('recent', this.recentIds());
    ref.setInput('i18n', {
      search: 'Search emoji',
      notfound: 'No emoji found',
      categories: { search: 'Search results', recent: 'Recently used' },
    });
    ref.setInput('style', { width: '100%', border: '0' });
    ref.instance.emojiSelect.subscribe((event: { emoji: { id?: string; native?: string } }) => {
      const native = event?.emoji?.native;
      if (native) {
        this.remember(event.emoji.id);
        this.picked.emit(native);
      }
    });
    this.pickerRef = ref;
    this.loading = false;
    this.cdr.detectChanges();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.pickerRef?.destroy();
  }

  setSkin(skin: Skin): void {
    this.skin = skin;
    this.skinMenuOpen = false;
    writeStorage(SKIN_KEY, skin);
    this.pickerRef?.setInput('skin', skin);
    this.cdr.markForCheck();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.skinMenuOpen) {
      this.skinMenuOpen = false;
      this.cdr.markForCheck();
      return;
    }
    this.closed.emit();
  }

  /**
   * Prefer above the anchor, else below; if neither side fits the full height, use the
   * roomier side and shrink. Horizontally aligned to the anchor's nearer edge, clamped.
   */
  @HostListener('window:resize')
  position(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.sheet = vw <= MOBILE_MAX;
    if (this.sheet) {
      this.height = Math.min(PICKER_HEIGHT, Math.round(vh * 0.6));
      this.cdr.markForCheck();
      return;
    }

    const width = Math.min(PICKER_WIDTH, vw - GAP * 2);
    const rect = this.anchor?.getBoundingClientRect();
    if (!rect) {
      this.height = Math.min(PICKER_HEIGHT, vh - GAP * 2);
      this.left = Math.max(GAP, (vw - width) / 2);
      this.top = Math.max(GAP, (vh - this.height) / 2);
      this.cdr.markForCheck();
      return;
    }

    const spaceAbove = rect.top - GAP * 2;
    const spaceBelow = vh - rect.bottom - GAP * 2;
    if (spaceAbove >= PICKER_HEIGHT) {
      this.height = PICKER_HEIGHT;
      this.top = rect.top - GAP - PICKER_HEIGHT;
    } else if (spaceBelow >= PICKER_HEIGHT) {
      this.height = PICKER_HEIGHT;
      this.top = rect.bottom + GAP;
    } else if (spaceAbove >= spaceBelow) {
      this.height = Math.max(Math.min(MIN_HEIGHT, vh - GAP * 2), spaceAbove);
      this.top = Math.max(GAP, rect.top - GAP - this.height);
    } else {
      this.height = Math.max(Math.min(MIN_HEIGHT, vh - GAP * 2), spaceBelow);
      this.top = Math.min(rect.bottom + GAP, vh - GAP - this.height);
    }

    const anchorCenter = rect.left + rect.width / 2;
    const preferred = anchorCenter > vw / 2 ? rect.right - width : rect.left;
    this.left = Math.min(Math.max(GAP, preferred), vw - width - GAP);
    this.cdr.markForCheck();
  }

  private recentIds(): string[] {
    const ids = readStorage<unknown>(RECENT_KEY, []);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, RECENT_MAX) : [];
  }

  /** Most recent first, no duplicates. */
  private remember(id: string | undefined): void {
    if (!id) {
      return;
    }
    writeStorage(RECENT_KEY, [id, ...this.recentIds().filter((x) => x !== id)].slice(0, RECENT_MAX));
  }
}
