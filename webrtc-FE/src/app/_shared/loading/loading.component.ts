import { Component, OnInit, Input } from '@angular/core';

@Component({
  selector: 'kp-loading',
  templateUrl: './loading.component.html',
  styleUrls: ['./loading.component.scss']
})
export class LoadingComponent implements OnInit {

  @Input() loading!: boolean;
  @Input() loadingText: string = 'Please wait...';

  constructor() { }

  ngOnInit(): void {
  }

}
