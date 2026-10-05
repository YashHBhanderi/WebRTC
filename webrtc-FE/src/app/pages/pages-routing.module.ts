import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { ChatComponent } from './chat/chat.component';
import { AuthGuard } from '../core/guards/auth.guard';
import { VideoCallComponent } from './video-call/video-call.component';
import { callLinkRedirect } from './group-call/call-link.guard';

const routes: Routes = [
  {
    path: 'chat',
    component: ChatComponent,
    canActivate: [AuthGuard]
  },
  {
    path: 'video-call/:receiverId',
    component: VideoCallComponent,
    canActivate: [AuthGuard]
  },
  // Legacy call URLs → the call opens on top of the chat (see call-link.guard.ts)
  {
    path: 'group-call/:groupId',
    component: ChatComponent,
    canActivate: [AuthGuard, callLinkRedirect]
  },
  {
    path: 'group-call-jitsi/:groupId',
    component: ChatComponent,
    canActivate: [AuthGuard, callLinkRedirect]
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class PageRoutingModule { }
