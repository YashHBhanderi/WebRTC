import { Pipe, PipeTransform } from '@angular/core';
import { mediaUrl } from 'src/app/core/utils/media-url.util';

/** `[src]="user.avatar | mediaUrl"` — S3 key → public URL (see mediaUrl). */
@Pipe({ name: 'mediaUrl', standalone: true })
export class MediaUrlPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return mediaUrl(value);
  }
}
