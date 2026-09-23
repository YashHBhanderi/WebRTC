import { Injectable } from '@angular/core';
import { DialogModule } from './dialog.module';
import { ConfirmationDialogComponent } from './confirmation-dialog/confirmation-dialog.component';
import { NgbModal, NgbModalOptions } from '@ng-bootstrap/ng-bootstrap';
import { ConfirmationDialogParams, InfoDialogParams } from './params';
import { InfoDialogComponent } from './info-dialog/info-dialog.component';

@Injectable({
  providedIn: DialogModule
})
export class DialogService {

  constructor(
    private modalService: NgbModal
  ) { }

  confirm(params?: ConfirmationDialogParams, options?: NgbModalOptions) {
    const modalRef = this.modalService.open(ConfirmationDialogComponent, options);
    if (params) {
      for (const param of Object.keys(params) as (keyof ConfirmationDialogParams)[]) {
        if (Object.prototype.hasOwnProperty.call(modalRef.componentInstance, param)) {
          modalRef.componentInstance[param] = params[param];
        }
      }
    }
    return modalRef;
  }

  info(params?: InfoDialogParams, options?: NgbModalOptions) {
    const modalRef = this.modalService.open(InfoDialogComponent, options);
    if (params) {
      for (const param of Object.keys(params) as (keyof InfoDialogParams)[]) {
        if (Object.prototype.hasOwnProperty.call(modalRef.componentInstance, param)) {
          modalRef.componentInstance[param] = params[param];
        }
      }
    }
    return modalRef;
  }
}
