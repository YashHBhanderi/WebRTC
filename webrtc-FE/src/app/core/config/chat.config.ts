import { InjectionToken } from '@angular/core';

/** Tunable chat UI settings. Override by providing CHAT_CONFIG in a module. */
export interface ChatConfig {
  /** Shown in the message hover strip, before the "+" (full picker) button. */
  quickReactions: string[];
  /** Text longer than this is collapsed behind "Read more". */
  readMoreChars: number;
  /** Server-side search page size. */
  searchPageSize: number;
  /** Message history page size. */
  historyPageSize: number;
}

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  quickReactions: ['😀', '❤️', '😂', '😮'],
  readMoreChars: 700,
  searchPageSize: 30,
  historyPageSize: 20,
};

export const CHAT_CONFIG = new InjectionToken<ChatConfig>('CHAT_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_CHAT_CONFIG,
});
