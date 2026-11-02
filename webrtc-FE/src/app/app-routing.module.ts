import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { guestGuard } from './core/guards/guest.guard';
import { AuthGuard } from './core/guards/auth.guard';

const routes: Routes = [
  {
    path: '',
    redirectTo: 'auth',
    pathMatch: 'full'
  },
  {
    path: 'auth',
    canActivate: [guestGuard],
    loadChildren: () => import('./authentication/authentication.module').then(m => m.AuthenticationModule),
  },
  {
    // SDK prototype demo (signed-in users only)
    path: 'sdk-demo',
    canActivate: [AuthGuard],
    loadComponent: () => import('./sdk-demo/sdk-demo.component').then(m => m.SdkDemoComponent),
  },
  {
    path:'',
    loadChildren: () => import('./pages/pages.module').then(m => m.PageModule),
  }
 
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
