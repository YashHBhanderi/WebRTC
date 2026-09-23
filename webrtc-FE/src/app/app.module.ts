import { NgModule, isDevMode } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { HTTP_INTERCEPTORS, HttpClientModule } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { SocketIoModule } from 'ngx-socket-io';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { SimplebarAngularModule } from 'simplebar-angular';
import { AuthInterceptor } from './core/interceptors/auth.interceptor';
import { ErrorInterceptor } from './core/interceptors/error.interceptor';
import { ServiceWorkerModule } from '@angular/service-worker';

const socketConfig = {
  url: typeof window !== 'undefined' ? window.location.origin : 'https://localhost:4200',
  options: {
    transports: ['websocket', 'polling'],
    autoConnect: false,
  },
};
// function getUsers(userService: UserService) {
//   return () => {
//     return new Promise((resolve, reject) => {
//       userService.getUsers().subscribe({
//         next: (response) => {
//           userService.users = response;
//           resolve(true);
//         },
//         error: (error) => {
//           console.error('Error fetching users:', error);
//           reject(false);
//         }
//       });
//     });
//   };
// }
@NgModule({
  declarations: [
    AppComponent,
  ],
  imports: [
    BrowserAnimationsModule,
    BrowserModule,
    AppRoutingModule,
    HttpClientModule,
    CommonModule,
    SocketIoModule.forRoot(socketConfig),
    SimplebarAngularModule,
    ServiceWorkerModule.register('ngsw-worker.js', {
      enabled: !isDevMode(),
      // Register the ServiceWorker as soon as the application is stable
      // or after 30 seconds (whichever comes first).
      registrationStrategy: 'registerWhenStable:30000'
    }),
  ],
  providers: [
    // {provide:APP_INITIALIZER,useFactory:getUsers,deps:[UserService],multi:true},
    { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
    { provide: HTTP_INTERCEPTORS, useClass: ErrorInterceptor, multi: true }
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }