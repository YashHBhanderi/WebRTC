import { Component, OnInit, Input } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';

@Component({
  selector: 'app-info-dialog',
  templateUrl: './info-dialog.component.html',
  styleUrls: ['./info-dialog.component.scss']
})
export class InfoDialogComponent implements OnInit {

  @Input() title = 'Confirm';
  @Input() content: string | any = 'Are you sure?';
  @Input() cancelBtn = 'Cancel';
  @Input() okBtn = 'Confirm';
  @Input() okType: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'danger' = 'primary';

  constructor(public activeModal: NgbActiveModal) { }

  ngOnInit() {
  }

  get isObjectContent() {
    return (typeof this.content) === 'object';
  }
}
