import { Pipe, PipeTransform } from '@angular/core';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Wraps matches of `term` in <mark>. The text is HTML-escaped first, so message
 * content can never inject markup; use with [innerHTML].
 */
@Pipe({ name: 'highlight' })
export class HighlightPipe implements PipeTransform {
  transform(text: string | null | undefined, term: string | null | undefined): string {
    const safe = escapeHtml(text || '');
    const query = (term || '').trim();
    if (query.length < 2) {
      return safe;
    }
    return safe.replace(new RegExp(escapeRegExp(escapeHtml(query)), 'gi'), (m) => `<mark>${m}</mark>`);
  }
}
