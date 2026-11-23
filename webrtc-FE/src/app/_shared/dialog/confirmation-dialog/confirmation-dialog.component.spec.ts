import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { ConfirmationDialogComponent } from './confirmation-dialog.component';

describe('ConfirmationDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmationDialogComponent>;
  let modal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(() => {
    modal = jasmine.createSpyObj<NgbActiveModal>('NgbActiveModal', ['close', 'dismiss']);
    TestBed.configureTestingModule({ declarations: [ConfirmationDialogComponent], providers: [{ provide: NgbActiveModal, useValue: modal }] });
    fixture = TestBed.createComponent(ConfirmationDialogComponent);
    fixture.componentInstance.okBtn = 'Delete';
    fixture.detectChanges();
  });

  it('OK closes (confirms); Cancel dismisses', () => {
    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    buttons.find((b) => b.textContent!.includes('Delete'))!.click();
    expect(modal.close).toHaveBeenCalled();
    buttons.find((b) => b.textContent!.includes('Cancel'))!.click();
    expect(modal.dismiss).toHaveBeenCalled();
  });
});
