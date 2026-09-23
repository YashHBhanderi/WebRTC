import { Component, OnInit, Input } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';

@Component({
  selector: 'app-confirmation-dialog',
  templateUrl: './confirmation-dialog.component.html',
  styleUrls: ['./confirmation-dialog.component.scss']
})
export class ConfirmationDialogComponent implements OnInit {

  @Input() title = 'Confirm';
  @Input() content = 'Are you sure?';
  @Input() cancelBtn = 'Cancel';
  @Input() okBtn = 'Confirm';
  @Input() okType: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'danger' = 'primary';
  @Input() showCloseBtn = true;

  constructor(public activeModal: NgbActiveModal) { }

  ngOnInit() {
  }
}
