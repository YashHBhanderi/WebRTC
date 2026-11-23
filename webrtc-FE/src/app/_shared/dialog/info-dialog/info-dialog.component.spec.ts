import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { InfoDialogComponent } from './info-dialog.component';

describe('InfoDialogComponent', () => {
  let fixture: ComponentFixture<InfoDialogComponent>;
  let modal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(() => {
    modal = jasmine.createSpyObj<NgbActiveModal>('NgbActiveModal', ['close', 'dismiss']);
    TestBed.configureTestingModule({ declarations: [InfoDialogComponent], providers: [{ provide: NgbActiveModal, useValue: modal }] });
    fixture = TestBed.createComponent(InfoDialogComponent);
    fixture.detectChanges();
  });

  it('the OK button closes the dialog', () => {
    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    buttons[buttons.length - 1].click();
    expect(modal.close).toHaveBeenCalled();
  });
});
