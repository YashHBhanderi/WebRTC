import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { StageItem } from '../call.models';

/** One participant (or shared screen) on the stage. Video stays mounted while hidden so toggling is instant. */
@Component({
  selector: 'app-call-tile',
  templateUrl: './call-tile.component.html',
  styleUrls: ['./call-tile.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallTileComponent {
  @Input() item!: StageItem;
  @Input() variant: 'main' | 'pip' | 'thumb' = 'thumb';
  @Input() kick = 0;
  /** Tiles that can be clicked to switch the main view */
  @Input() selectable = false;
  @Output() activate = new EventEmitter<string>();

  get initial(): string {
    return (this.item?.name || '?').trim().charAt(0).toUpperCase();
  }

  onActivate(): void {
    if (this.selectable) {
      this.activate.emit(this.item.key);
    }
  }
}
