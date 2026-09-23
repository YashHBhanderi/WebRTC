import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConfirmationDialogComponent } from './confirmation-dialog/confirmation-dialog.component';
import { FormsModule } from '@angular/forms';
import { InfoDialogComponent } from './info-dialog/info-dialog.component';

@NgModule({
  declarations: [
    ConfirmationDialogComponent,
    InfoDialogComponent
  ],
  imports: [
    CommonModule,
    FormsModule,
  ],
  exports: [
    ConfirmationDialogComponent,
    InfoDialogComponent
  ]
})
export class DialogModule { }
