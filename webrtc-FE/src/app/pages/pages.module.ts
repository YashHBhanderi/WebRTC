import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PageRoutingModule } from './pages-routing.module';
import { ChatComponent } from './chat/chat.component';
import { NewChatDialogComponent } from './chat/new-chat-dialog.component';
import { GroupCallComponent } from './group-call/group-call.component';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { SimplebarAngularModule } from 'simplebar-angular';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { SharedModule } from '../_shared/shared.module';
import { CallTileComponent } from './group-call/call-tile/call-tile.component';
import { CallPrejoinComponent } from './group-call/call-prejoin/call-prejoin.component';
import { CallDurationComponent } from './group-call/call-duration.component';
import { MediaSrcDirective } from './group-call/media-src.directive';
import { IncomingCallComponent } from './chat/incoming-call/incoming-call.component';
import { HighlightPipe } from './chat/highlight.pipe';
import { LongPressDirective } from './chat/long-press.directive';
import { AvatarComponent } from './shared/avatar.component';
import { MediaUrlPipe } from './shared/media-url.pipe';
import { FileSizePipe } from './shared/file-size.pipe';
import { EmojiPickerComponent } from './shared/emoji-picker.component';
import { MessageItemComponent } from './chat/message-item/message-item.component';
import { MessageComposerComponent } from './chat/message-composer/message-composer.component';
import { MessageSearchPanelComponent } from './chat/message-search-panel/message-search-panel.component';
import { ConversationInfoPanelComponent } from './chat/conversation-info-panel/conversation-info-panel.component';
import { SidebarProfileComponent } from './chat/sidebar-profile/sidebar-profile.component';
import { MeetingChatComponent } from './group-call/meeting-chat/meeting-chat.component';
import { DishLayoutDirective } from './group-call/dish-layout.directive';
import { ShellComponent } from './shell/shell.component';
import { GlobalSearchComponent } from './shell/global-search.component';
import { ActivityPageComponent } from './shell/activity-page.component';
import { ActivityContextComponent } from './shell/activity-context.component';
import { SavedPageComponent } from './shell/saved-page.component';
import { FilesPageComponent } from './shell/files-page.component';
import { CallsPageComponent } from './shell/calls-page.component';
import { CalendarPageComponent } from './shell/calendar-page.component';
import { MeetingDetailsComponent } from './shell/meeting-details.component';
import { RecordingCardComponent } from './chat/recording-card/recording-card.component';
import { TimeGridComponent } from './shell/time-grid.component';
import { CalendarSettingsComponent } from './shell/calendar-settings.component';
import { MeetingEditorComponent } from './shell/meeting-editor.component';
import { MeetJoinComponent } from './shell/meet-join.component';
import { RecordingPageComponent } from './shell/recording-page.component';
import { ProfilePageComponent, SectionPlaceholderComponent, SettingsPageComponent } from './shell/section-pages.component';
import { WorkspaceListComponent } from './shell/workspace-list.component';
import { CreateOrganizationComponent } from './organizations/create-organization.component';
import { DeveloperAppsComponent } from './developer/developer-apps.component';
import { DeveloperAppComponent } from './developer/developer-app.component';
import { DeveloperDocsComponent } from './developer/developer-docs.component';
import { ConsentComponent } from './developer/consent.component';
import { DeveloperShellComponent } from './developer/developer-shell.component';
import { JoinOrganizationComponent } from './organizations/join-organization.component';
import { InvitationAcceptComponent } from './organizations/invitation-accept.component';
import { OrganizationHomeComponent } from './organizations/organization-home.component';
import { OrganizationSettingsComponent } from './organizations/organization-settings.component';
import { TeamPageComponent } from './organizations/team-page.component';
import { CreateChannelDialogComponent, CreateTeamDialogComponent } from './organizations/team-dialogs.component';
import { PersonPickerComponent } from './shared/person-picker.component';

@NgModule({
  declarations: [
    ChatComponent,
    NewChatDialogComponent,
    GroupCallComponent,
    CallTileComponent,
    CallPrejoinComponent,
    CallDurationComponent,
    MediaSrcDirective,
    IncomingCallComponent,
    HighlightPipe,
    LongPressDirective,
    EmojiPickerComponent,
    MessageItemComponent,
    MessageComposerComponent,
    MessageSearchPanelComponent,
    ConversationInfoPanelComponent,
    SidebarProfileComponent,
    MeetingChatComponent,
    DishLayoutDirective,
    ShellComponent,
    GlobalSearchComponent,
    ActivityPageComponent,
    ActivityContextComponent,
    SavedPageComponent,
    FilesPageComponent,
    CallsPageComponent,
    CalendarPageComponent,
    TimeGridComponent,
    RecordingCardComponent,
    MeetingDetailsComponent,
    CalendarSettingsComponent,
    MeetingEditorComponent,
    MeetJoinComponent,
    RecordingPageComponent,
    SectionPlaceholderComponent,
    ProfilePageComponent,
    SettingsPageComponent,
    WorkspaceListComponent,
    CreateOrganizationComponent,
    DeveloperAppsComponent,
    DeveloperAppComponent,
    DeveloperDocsComponent,
    ConsentComponent,
    DeveloperShellComponent,
    JoinOrganizationComponent,
    InvitationAcceptComponent,
    OrganizationHomeComponent,
    OrganizationSettingsComponent,
    TeamPageComponent,
    CreateTeamDialogComponent,
    CreateChannelDialogComponent,
    PersonPickerComponent,
  ],
  imports: [
    SharedModule,
    AvatarComponent,
    MediaUrlPipe,
    FileSizePipe,
    CommonModule,
    PageRoutingModule,
    NgbModule,
    FormsModule,
    ReactiveFormsModule,
    SimplebarAngularModule,
    NgxSkeletonLoaderModule,
  ]
})
export class PageModule { }
