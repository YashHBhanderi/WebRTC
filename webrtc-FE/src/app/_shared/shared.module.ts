import { NgModule } from '@angular/core';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { DialogModule } from './dialog/dialog.module';
import { NgbModalModule, NgbCollapseModule, NgbDropdownModule, NgbNavModule, NgbTooltipModule } from '@ng-bootstrap/ng-bootstrap';
import { LoadingModule } from './loading/loading.module';

@NgModule({
  declarations: [
  ],
  imports: [
    FormsModule,
    ReactiveFormsModule,
    CommonModule,
    LoadingModule,
    DialogModule,
    NgbModalModule,
    NgbCollapseModule,
    NgbNavModule,
    NgbDropdownModule,
    NgbTooltipModule,
  ],
  exports: [
    FormsModule,
    ReactiveFormsModule,
    LoadingModule,
    DialogModule,
    NgbModalModule,
    NgbCollapseModule,
    NgbNavModule,
    NgbDropdownModule,
    NgbTooltipModule,

  ]
})
export class SharedModule { }
