import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PageRoutingModule } from './pages-routing.module';
import { ChatComponent } from './chat/chat.component';
import { GroupCallComponent } from './group-call/group-call.component';
import { JistiMeetComponent } from './jisti-meet/jisti-meet.component';
import { VideoCallComponent } from './video-call/video-call.component';
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
import { EmojiPickerComponent } from './shared/emoji-picker.component';
import { MessageItemComponent } from './chat/message-item/message-item.component';
import { MessageComposerComponent } from './chat/message-composer/message-composer.component';
import { MessageSearchPanelComponent } from './chat/message-search-panel/message-search-panel.component';
import { ConversationInfoPanelComponent } from './chat/conversation-info-panel/conversation-info-panel.component';
import { SidebarProfileComponent } from './chat/sidebar-profile/sidebar-profile.component';
import { MeetingChatComponent } from './group-call/meeting-chat/meeting-chat.component';
import { DishLayoutDirective } from './group-call/dish-layout.directive';

@NgModule({
  declarations: [
    ChatComponent,
    VideoCallComponent,
    GroupCallComponent,
    JistiMeetComponent,
    CallTileComponent,
    CallPrejoinComponent,
    CallDurationComponent,
    MediaSrcDirective,
    IncomingCallComponent,
    HighlightPipe,
    LongPressDirective,
    AvatarComponent,
    EmojiPickerComponent,
    MessageItemComponent,
    MessageComposerComponent,
    MessageSearchPanelComponent,
    ConversationInfoPanelComponent,
    SidebarProfileComponent,
    MeetingChatComponent,
    DishLayoutDirective,
  ],
  imports: [
    SharedModule,
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
