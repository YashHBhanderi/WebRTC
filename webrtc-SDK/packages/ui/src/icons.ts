import { svg, type SVGTemplateResult } from "lit";

/**
 * Line icons (24×24, stroke = currentColor), drawn for this package. Replace any of them with
 * `setIcon(name, paths)` or by slotting your own icon set where components offer slots.
 */
const PATHS: Record<string, string[]> = {
    send: ["M21 3 3 10.5l7 3 3 7L21 3z", "M10 13.5 21 3"],
    paperclip: ["M15.5 6.5 7.7 14.3a2.5 2.5 0 0 0 3.5 3.5l8-8a4.5 4.5 0 0 0-6.4-6.4l-8 8a6.5 6.5 0 0 0 9.2 9.2l7-7"],
    smile: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8.5 14.5c1.8 2 5.2 2 7 0", "M9 9.5h.01", "M15 9.5h.01"],
    x: ["M6 6l12 12", "M18 6 6 18"],
    check: ["M5 12.5 9.5 17 19 7.5"],
    "check-double": ["M2.5 12.5 7 17l9.5-9.5", "M12 16l1 1 9.5-9.5"],
    phone: ["M5 4h3.5l2 5L8 10.5a11 11 0 0 0 5.5 5.5L15 13.5l5 2V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"],
    "phone-off": ["M3 13.5c5-5 13-5 18 0L18.5 16 15 14.5V12a9 9 0 0 0-6 0v2.5L5.5 16z"],
    video: ["M4 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z", "M16 10.5l5-3v9l-5-3"],
    "video-off": ["M4 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z", "M16 10.5l5-3v9l-5-3", "M3 3l18 18"],
    mic: ["M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M5.5 11a6.5 6.5 0 0 0 13 0", "M12 17.5V21", "M8.5 21h7"],
    "mic-off": ["M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M5.5 11a6.5 6.5 0 0 0 13 0", "M12 17.5V21", "M3 3l18 18"],
    screen: ["M3 5h18v11H3z", "M8 20h8", "M12 16v4", "M12 13V8", "M9.5 10.5 12 8l2.5 2.5"],
    users: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M2.5 20a6.5 6.5 0 0 1 13 0", "M16 4.2a3.5 3.5 0 0 1 0 6.6", "M18.5 20a6.5 6.5 0 0 0-3-5.5"],
    "user-plus": ["M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M3.5 20a6.5 6.5 0 0 1 13 0", "M19 8v6", "M16 11h6"],
    "user-minus": ["M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M3.5 20a6.5 6.5 0 0 1 13 0", "M16 11h6"],
    search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M15.5 15.5 20 20"],
    bell: ["M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z", "M10 20.5a2 2 0 0 0 4 0"],
    file: ["M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M14 3v5h5"],
    image: ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M15.5 9h.01"],
    download: ["M12 4v11", "M7.5 10.5 12 15l4.5-4.5", "M5 20h14"],
    more: ["M12 5h.01", "M12 12h.01", "M12 19h.01"],
    lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
    alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17h.01"],
    info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 11v5", "M12 8h.01"],
    "chevron-left": ["M15 5l-7 7 7 7"],
    "chevron-right": ["M9 5l7 7-7 7"],
    "chevron-down": ["M6 9l6 6 6-6"],
    plus: ["M12 5v14", "M5 12h14"],
    trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
    edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
    reply: ["M10 8 5 12.5 10 17", "M5 12.5h9a5 5 0 0 1 5 5V19"],
    pin: ["M15 4l5 5-3 1-3.5 3.5L13 18l-7-7 4.5-.5L14 7z", "M9 15l-5 5"],
    crown: ["M4 8l4 4 4-7 4 7 4-4-2 10H6z"],
    logout: ["M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4", "M10 16l-4-4 4-4", "M6 12h10"],
    calendar: ["M4 6h16v14H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
    link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
    hand: ["M8 12V6a1.5 1.5 0 0 1 3 0v5", "M11 11V4.5a1.5 1.5 0 0 1 3 0V11", "M14 11V6a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7 6 6 0 0 1-5-3l-2.5-4.5a1.5 1.5 0 0 1 2.5-1.5L8 14"],
    grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
    message: ["M4 5h16v11H9l-5 4z"],
    "arrow-down": ["M12 5v14", "M6 13l6 6 6-6"],
    record: ["M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"],
    shield: ["M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"],
    settings: ["M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"],
};

const BOLD = new Set(["more"]);

export type IconName = keyof typeof PATHS | (string & {});

/** Replace or add an icon (24×24 stroked path data). */
export function setIcon(name: string, paths: string[]): void {
    PATHS[name] = paths;
}

/** Inline SVG icon for Lit templates. Decorative by default (aria-hidden). */
export function icon(name: IconName, size = 20): SVGTemplateResult {
    const paths = PATHS[name] || PATHS.info;
    return svg`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width=${BOLD.has(name) ? 3 : 1.8} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths.map(
            (d) => svg`<path d=${d}></path>`,
        )}</svg>`;
}
