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
