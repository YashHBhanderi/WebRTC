import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { ChatComponent } from './chat/chat.component';
import { AuthGuard } from '../core/guards/auth.guard';
import { callLinkRedirect } from './group-call/call-link.guard';
import { ShellComponent } from './shell/shell.component';
import { ActivityPageComponent } from './shell/activity-page.component';
import { SavedPageComponent } from './shell/saved-page.component';
import { FilesPageComponent } from './shell/files-page.component';
import { CallsPageComponent } from './shell/calls-page.component';
import { CalendarPageComponent } from './shell/calendar-page.component';
import { MeetJoinComponent } from './shell/meet-join.component';
import { RecordingPageComponent } from './shell/recording-page.component';
import { ProfilePageComponent, SectionPlaceholderComponent, SettingsPageComponent } from './shell/section-pages.component';
import { CreateOrganizationComponent } from './organizations/create-organization.component';
import { DeveloperAppsComponent } from './developer/developer-apps.component';
import { DeveloperAppComponent } from './developer/developer-app.component';
import { DeveloperDocsComponent } from './developer/developer-docs.component';
import { ConsentComponent } from './developer/consent.component';
import { JoinOrganizationComponent } from './organizations/join-organization.component';
import { InvitationAcceptComponent } from './organizations/invitation-accept.component';
import { OrganizationHomeComponent } from './organizations/organization-home.component';
import { OrganizationSettingsComponent } from './organizations/organization-settings.component';
import { TeamPageComponent } from './organizations/team-page.component';

const placeholder = (title: string, icon: string, emptyTitle: string, emptyText: string) => ({
  component: SectionPlaceholderComponent,
  title,
  data: { title, icon, emptyTitle, emptyText },
});

const routes: Routes = [
  {
    path: '',
    component: ShellComponent,
    canActivate: [AuthGuard],
    children: [
      { path: 'chat', component: ChatComponent, title: 'Chat' },
      { path: 'profile', component: ProfilePageComponent, title: 'Profile' },
      { path: 'settings', component: SettingsPageComponent, title: 'Settings' },
      { path: 'organizations/new', component: CreateOrganizationComponent, title: 'Create an organization' },
      // Developer Portal (register applications, credentials, permissions, webhooks, usage) + end-user consent
      { path: 'developer', component: DeveloperAppsComponent, title: 'Developer portal' },
      { path: 'developer/docs', component: DeveloperDocsComponent, title: 'API documentation' },
      { path: 'developer/apps/:appId', component: DeveloperAppComponent, title: 'Application' },
      { path: 'consent', component: ConsentComponent, title: 'Authorize application' },
      { path: 'organizations/join', component: JoinOrganizationComponent, title: 'Join an organization' },
      { path: 'organizations/invitation', component: InvitationAcceptComponent, title: 'Organization invitation' },
      { path: 'organization', component: OrganizationHomeComponent, title: 'Organization' },
      { path: 'organization/settings', component: OrganizationSettingsComponent, title: 'Organization settings' },
      // Canonical: members, invitations and join requests live in the settings' Members section
      { path: 'organization/members', redirectTo: 'organization/settings?tab=members', pathMatch: 'full' },
      { path: 'organization/invitations', redirectTo: 'organization/settings?tab=members&invite=1', pathMatch: 'full' },
      // Former Account & organizations page: its parts now live in the profile menu and on Profile
      { path: 'account', redirectTo: 'profile', pathMatch: 'full' },
      { path: 'teams/:teamId', component: TeamPageComponent, title: 'Team' },
      { path: 'activity', component: ActivityPageComponent, title: 'Activity' },
      { path: 'saved', component: SavedPageComponent, title: 'Saved messages' },
      { path: 'calls', component: CallsPageComponent, title: 'Calls' },
      { path: 'calendar', component: CalendarPageComponent, title: 'Calendar' },
      { path: 'meet', component: MeetJoinComponent, title: 'Join a meeting' },
      { path: 'meet/:code', component: MeetJoinComponent, title: 'Join a meeting' },
      { path: 'recordings/:id', component: RecordingPageComponent, title: 'Recording' },
      { path: 'files', component: FilesPageComponent, title: 'Files' },
      // Legacy call URLs → the call opens on top of the chat (see call-link.guard.ts)
      { path: 'group-call/:groupId', component: ChatComponent, canActivate: [callLinkRedirect] },
      { path: '', pathMatch: 'full', redirectTo: 'chat' },
    ],
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class PageRoutingModule { }
