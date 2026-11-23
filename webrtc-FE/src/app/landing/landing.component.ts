import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

interface Feature {
  icon: string;
  title: string;
  text: string;
}

/** Top navigation entry: a plain link, or a label with a small menu. */
interface NavLink { label: string; section?: string; portal?: 'personal' | 'developer'; }
interface NavItem extends NavLink { items?: NavLink[]; }

interface UseCase extends Feature {
  visual: 'personal' | 'business' | 'developer';
  portal: 'personal' | 'developer';
}

/** One token of the code preview: text plus a highlight class ('' = plain). */
interface Tok { t: string; c: '' | 'k' | 's' | 'p' | 'm'; }

/** One layer of the section wave: its resting edge, the closed shape, and the SMIL keyframes. */
interface WaveLayer { line: string; shape: string; lines: string; shapes: string; dur: string; }

const WAVE_CLOSE = ' L 1000 200 L 0 200 Z';

/** Layers in a 1000×200 viewBox; frames[0] is the resting edge and the loop returns to it. */
function waveLayer(dur: string, frames: string[]): WaveLayer {
  const loop = [...frames, frames[0]];
  return {
    line: frames[0],
    shape: frames[0] + WAVE_CLOSE,
    lines: loop.join('; '),
    shapes: loop.map((f) => f + WAVE_CLOSE).join('; '),
    dur,
  };
}

/** Section wave, painted back to front: deep, mid, fore. The deep layer is also the solid edge of the next section. */
const WAVE = {
  deep: waveLayer('14s', [
    'M 0 130 C 260 135, 450 170, 670 165 C 830 160, 930 130, 1000 120',
    'M 0 120 C 240 125, 430 160, 650 155 C 815 150, 920 122, 1000 112',
    'M 0 136 C 275 142, 465 178, 685 172 C 845 168, 940 138, 1000 128',
    'M 0 126 C 250 130, 440 165, 660 160 C 825 155, 925 125, 1000 116',
  ]),
  mid: waveLayer('11s', [
    'M 0 115 C 240 120, 420 160, 640 155 C 800 150, 910 115, 1000 102',
    'M 0 106 C 220 108, 400 150, 620 145 C 785 140, 900 108, 1000 94',
    'M 0 122 C 255 130, 440 166, 655 162 C 815 156, 920 122, 1000 110',
    'M 0 112 C 230 115, 410 155, 630 150 C 790 145, 905 112, 1000 98',
  ]),
  fore: waveLayer('8.5s', [
    'M 0 95 C 220 95, 380 145, 580 145 C 760 145, 870 95, 1000 78',
    'M 0 88 C 210 82, 370 138, 570 136 C 755 132, 865 88, 1000 72',
    'M 0 102 C 235 106, 395 152, 595 150 C 770 148, 880 102, 1000 84',
    'M 0 92 C 205 90, 365 142, 565 140 C 750 138, 860 92, 1000 76',
  ]),
};

/**
 * Public landing page ("/") for visitors who are not signed in. Introduces SpreeWe as a personal
 * communication app and as a communication API platform, with two ways in: Sign in (personal app)
 * and Developer Portal. Both use the same SpreeWe account; the link carries the chosen portal.
 * Signed-in visitors never see this page (landingGuard sends them to their portal).
 *
 * Product visuals are drawn in HTML/CSS (illustrative, not live data); photographs are in assets/landing.
 * The design is drawn for a 1024px viewport and scales with it: --k (set here) is viewport / 1024.
 */
@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, RouterModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './landing.component.html',
  styleUrls: ['./landing.component.scss'],
})
export class LandingComponent implements AfterViewInit, OnDestroy {
  readonly year = new Date().getFullYear();
  readonly wave = WAVE;
  /** SMIL wave animation is not covered by the CSS reduced-motion rule, so the template drops it. */
  readonly reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  menuOpen = false;

  /**
   * Header links. In-page entries scroll to a section; portal entries go to sign-in for that portal.
   * TODO(product): Pricing, Resources and Support have no pages yet, so they point at the closest section.
   */
  readonly nav: NavItem[] = [
    { label: 'Product', section: 'personal', items: [
      { label: 'Chat, calls and meetings', section: 'personal' },
      { label: 'Use cases', section: 'use-cases' },
      { label: 'Sign in to SpreeWe', portal: 'personal' },
    ] },
    { label: 'Developers', section: 'developers', items: [
      { label: 'Platform overview', section: 'developers' },
      { label: 'Developer Portal', portal: 'developer' },
    ] },
    { label: 'Pricing', section: 'portals' },
    { label: 'Resources', section: 'use-cases', items: [
      { label: 'API example', section: 'developers' },
      { label: 'Use cases', section: 'use-cases' },
      { label: 'Get started', section: 'portals' },
    ] },
  ];
  readonly footerNav: NavLink[] = [
    { label: 'Product', section: 'personal' },
    { label: 'Developers', section: 'developers' },
    { label: 'Pricing', section: 'portals' },
    { label: 'Resources', section: 'use-cases' },
    { label: 'Support', section: 'portals' },
  ];
  codeTab: 'request' | 'response' = 'request';
  copied = false;
  private observer?: IntersectionObserver;
  private copiedTimer?: ReturnType<typeof setTimeout>;
  private frame = 0;
  private readonly onScroll = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      // Parallax: hero mockups, floating icons and backdrop shapes drift at different speeds (CSS reads --sy)
      const el = this.host.nativeElement;
      el.style.setProperty('--sy', String(Math.min(window.scrollY, 1600)));
      el.classList.toggle('is-scrolled', window.scrollY > 8);
    });
  };
  /** Design scale: 1 at a 1024px viewport, up to 1.5 on wide screens; phones / tablets use a fixed larger step. */
  private readonly onResize = () => {
    const w = window.innerWidth;
    const desktop = w > 860;
    const k = desktop ? Math.min(w / 1024, 1.5) : 1.3;
    const style = this.host.nativeElement.style;
    style.setProperty('--k', k.toFixed(4));
    // Hero device canvas (604px wide): scales with the page on desktop, fits the column when stacked
    style.setProperty('--ks', (desktop ? k : Math.min((w - 32) / 604, 1.2)).toFixed(4));
  };
  /** Pointer parallax on the hero devices (fine pointers only); CSS reads --mx / --my in the range -1..1. */
  private pointerFrame = 0;
  private readonly onPointer = (e: PointerEvent) => {
    if (this.pointerFrame || e.pointerType !== 'mouse') return;
    this.pointerFrame = requestAnimationFrame(() => {
      this.pointerFrame = 0;
      const el = this.host.nativeElement;
      el.style.setProperty('--mx', ((e.clientX / window.innerWidth) * 2 - 1).toFixed(3));
      el.style.setProperty('--my', ((e.clientY / window.innerHeight) * 2 - 1).toFixed(3));
    });
  };

  readonly personalFeatures: Feature[] = [
    { icon: 'ti-message-dots', title: 'Direct and group chat', text: 'Conversations with reactions, replies, pinned messages and powerful search.' },
    { icon: 'ti-video', title: 'Audio and video calls', text: 'One-to-one and group calls with screen sharing and high-quality video.' },
    { icon: 'ti-calendar-event', title: 'Meetings and calendar', text: 'Schedule meetings, share a join link and keep everything in one calendar.' },
    { icon: 'ti-circle-dot', title: 'Recordings', text: 'Record meetings and replay anytime with automatic transcripts.' },
    { icon: 'ti-lock', title: 'End-to-end encryption', text: 'Messages are encrypted on your devices and stay private and secure.' },
    { icon: 'ti-users', title: 'Organizations and teams', text: 'Create organizations, manage teams, channels, roles and invitations.' },
  ];

  readonly developerFeatures: Feature[] = [
    { icon: 'ti-stack-2', title: 'Applications', text: 'Register and manage your applications.' },
    { icon: 'ti-key', title: 'Credentials', text: 'Create, rotate and revoke API keys.' },
    { icon: 'ti-shield', title: 'Permissions', text: 'Define granular access controls.' },
    { icon: 'ti-webhook', title: 'Webhooks', text: 'Get real-time events for messages, calls and more.' },
    { icon: 'ti-refresh', title: 'OAuth 2.0 with PKCE', text: 'Secure and standards-based authentication.' },
    { icon: 'ti-code', title: 'REST API', text: 'Well-documented APIs for chat, call, files and meetings.' },
  ];

  readonly useCases: UseCase[] = [
    { icon: 'ti-users', title: 'Personal use', text: 'A reliable and secure place to chat, call and meet with the people who matter.', visual: 'personal', portal: 'personal' },
    { icon: 'ti-users', title: 'Business use', text: 'Collaborate with your organization through team chat, calls and meetings with the right controls.', visual: 'business', portal: 'personal' },
    { icon: 'ti-code', title: 'Developer use', text: 'Integrate chat, calling and meeting capabilities into your own product using our secure APIs.', visual: 'developer', portal: 'developer' },
  ];

  /** A real endpoint: POST /v1/contacts/start (scope contacts:write) opens or reuses a direct conversation. */
  readonly request: Tok[][] = [
    [{ t: 'curl -X POST ', c: '' }, { t: '"$SPREEWE_API/v1/contacts/start"', c: 's' }, { t: ' \\', c: '' }],
    [{ t: '  -H ', c: '' }, { t: '"Authorization: Bearer <ACCESS_TOKEN>"', c: 's' }, { t: ' \\', c: '' }],
    [{ t: '  -H ', c: '' }, { t: '"Content-Type: application/json"', c: 's' }, { t: ' \\', c: '' }],
    [{ t: '  -d ', c: '' }, { t: "'{", c: 'p' }],
    [{ t: '    ', c: '' }, { t: '"email"', c: 'k' }, { t: ': ', c: '' }, { t: '"alex@example.com"', c: 's' }, { t: ',', c: '' }],
    [{ t: '    ', c: '' }, { t: '"scope"', c: 'k' }, { t: ': ', c: '' }, { t: '"member"', c: 's' }],
    [{ t: "  }'", c: 'p' }],
  ];

  /** That endpoint's response shape (values are examples). */
  readonly response: Tok[][] = [
    [{ t: 'HTTP/1.1 201 Created', c: 'm' }],
    [{ t: '{', c: 'p' }],
    [{ t: '  ', c: '' }, { t: '"data"', c: 'k' }, { t: ': {', c: '' }],
    [{ t: '    ', c: '' }, { t: '"conversationId"', c: 'k' }, { t: ': ', c: '' }, { t: '"6650c2a1f0e4b3…"', c: 's' }, { t: ',', c: '' }],
    [{ t: '    ', c: '' }, { t: '"external"', c: 'k' }, { t: ': ', c: '' }, { t: 'false', c: 'm' }],
    [{ t: '  }', c: '' }],
    [{ t: '}', c: 'p' }],
  ];

  constructor(private host: ElementRef<HTMLElement>, private cdr: ChangeDetectorRef, private zone: NgZone) {
    // Before the first paint, so the page never renders at the wrong scale
    if (typeof window !== 'undefined') this.onResize();
  }

  ngAfterViewInit(): void {
    // Hide the page scrollbar while the landing page is shown (scrolling still works; see styles.scss)
    document.documentElement.classList.add('lp-no-scrollbar');
    const reduced = this.reducedMotion;
    const items = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (typeof IntersectionObserver === 'undefined' || reduced) {
      items.forEach((el) => el.classList.add('is-visible'));
    } else {
      // Fade / slide in as sections enter the viewport (everything visible without IntersectionObserver)
      this.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            this.observer?.unobserve(entry.target);
          }
        }
      }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
      items.forEach((el) => this.observer!.observe(el));
    }
    // Outside Angular: scrolling / resizing / pointer moves must not trigger change detection
    this.zone.runOutsideAngular(() => {
      window.addEventListener('resize', this.onResize, { passive: true });
      window.addEventListener('scroll', this.onScroll, { passive: true });
      if (!reduced) window.addEventListener('pointermove', this.onPointer, { passive: true });
    });
    this.onScroll();
  }

  ngOnDestroy(): void {
    document.documentElement.classList.remove('lp-no-scrollbar');
    this.observer?.disconnect();
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointermove', this.onPointer);
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.pointerFrame);
    clearTimeout(this.copiedTimer);
  }

  /** In-page section links: smooth scroll without a router navigation (the URL stays "/"). */
  scrollTo(event: Event, id: string): void {
    event.preventDefault();
    this.menuOpen = false;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  get codeLines(): Tok[][] {
    return this.codeTab === 'request' ? this.request : this.response;
  }

  async copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.codeLines.map((line) => line.map((tok) => tok.t).join('')).join('\n'));
      this.copied = true;
      this.cdr.markForCheck();
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => { this.copied = false; this.cdr.markForCheck(); }, 1800);
    } catch {
      // Clipboard blocked (insecure context / permissions): the code stays selectable
    }
  }
}
