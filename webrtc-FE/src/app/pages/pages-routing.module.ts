import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { ChatComponent } from './chat/chat.component';
import { AuthGuard } from '../core/guards/auth.guard';
import { GroupCallComponent } from './group-call/group-call.component';
import { VideoCallComponent } from './video-call/video-call.component';

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
  {
    path: 'group-call/:groupId',
    component: GroupCallComponent,
    canActivate: [AuthGuard]
  },
  {
    path: 'group-call-jitsi/:groupId',
    component: GroupCallComponent,
    canActivate: [AuthGuard]
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class PageRoutingModule { }
