import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

/**
 * Calls now live on top of the chat page so they survive navigation (minimize + keep chatting).
 * Old `/group-call/:groupId?callId=…&callType=…` links (e.g. inside call messages) are
 * redirected to `/chat?call=…`, which opens the call there.
 */
export const callLinkRedirect: CanActivateFn = (route) => {
  const router = inject(Router);
  const callId = route.queryParamMap.get('callId');
  const groupId = route.paramMap.get('groupId');
  if (!callId || !groupId) {
    return router.createUrlTree(['/chat']);
  }
  return router.createUrlTree(['/chat'], {
    queryParams: {
      call: callId,
      g: groupId,
      t: route.queryParamMap.get('callType') === 'audio' ? 'audio' : 'video',
      join: '1',
    },
  });
};
