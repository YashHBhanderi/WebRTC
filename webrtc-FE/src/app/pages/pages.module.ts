import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PageRoutingModule } from './pages-routing.module';
import { ChatComponent } from './chat/chat.component';
import { GroupCallComponent } from './group-call/group-call.component';
import { GroupInfoComponent } from './group-info/group-info.component';
import { JistiMeetComponent } from './jisti-meet/jisti-meet.component';
import { ProfileComponent } from './profile/profile.component';
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

@NgModule({
  declarations: [
    ChatComponent,
    VideoCallComponent,
    GroupCallComponent,
    ProfileComponent,
    GroupInfoComponent,
    JistiMeetComponent,
    CallTileComponent,
    CallPrejoinComponent,
    CallDurationComponent,
    MediaSrcDirective,
    IncomingCallComponent,
    HighlightPipe,
    LongPressDirective,
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
