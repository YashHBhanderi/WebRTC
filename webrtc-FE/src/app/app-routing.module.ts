import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { guestGuard } from './core/guards/guest.guard';
import { landingGuard } from './core/guards/portal.guard';

const routes: Routes = [
  // Public landing page; signed-in visitors go straight to their portal
  {
    path: '',
    pathMatch: 'full',
    canActivate: [landingGuard],
    title: 'SpreeWe · Communication for people and developers',
    loadComponent: () => import('./landing/landing.component').then(m => m.LandingComponent),
  },
  {
    path: 'auth',
    canActivate: [guestGuard],
    loadChildren: () => import('./authentication/authentication.module').then(m => m.AuthenticationModule),
  },
  {
    path: '',
    loadChildren: () => import('./pages/pages.module').then(m => m.PageModule),
  },
  // Unknown address: landing page (or the visitor's portal when signed in)
  { path: '**', redirectTo: '' },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
