import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { SKIP_ERROR_TOAST } from 'src/app/core/interceptors/error.interceptor';
import { workspaceNavigation } from 'src/app/core/services/workspace-sync.service';

/**
 * Switch this tab to another workspace (null = personal) — the one implementation, used by the
 * Account & organization section of the profile menu.
 *
 * Deliberately a full reload: Clerk's active organization changes, the server confirms the new context
 * (membership / tenant status re-checked), and the app restarts, so no conversation, contact, presence
 * or call state from the previous workspace stays in memory and the socket reconnects with a token for
 * the new one. If the server refuses, the tab goes back to `previous` (nothing half-switched) and the
 * error is rethrown for the caller to show.
 */
export async function switchWorkspace(clerk: ClerkService, http: HttpClient, orgId: string | null, previous: string | null): Promise<void> {
  try {
    await clerk.setActiveOrganization(orgId);
    if (orgId) {
      await firstValueFrom(http.get(`${environment.apiUrl}/v1/workspace`, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) }));
    }
    workspaceNavigation.assign(orgId ? '/organization' : '/chat');
  } catch (error) {
    await clerk.setActiveOrganization(previous).catch(() => undefined);
    throw error;
  }
}
