import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DialogModule } from '../dialog/dialog.module';
import { ToastHostComponent } from './toast-host.component';

@NgModule({
  declarations: [ToastHostComponent],
  imports: [
    CommonModule,
    DialogModule,
  ],
  exports: [ToastHostComponent]
})
export class AlertModule { }
