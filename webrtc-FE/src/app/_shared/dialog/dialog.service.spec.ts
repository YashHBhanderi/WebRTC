import { TestBed } from '@angular/core/testing';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { DialogService } from './dialog.service';
import { ConfirmationDialogComponent } from './confirmation-dialog/confirmation-dialog.component';

describe('DialogService', () => {
  it("opens the confirmation dialog and copies only the dialog's own inputs", () => {
    const instance: Record<string, unknown> = { title: 'Confirm', content: 'Are you sure?' };
    const modal = { open: jasmine.createSpy('open').and.returnValue({ componentInstance: instance, result: Promise.resolve(true) }) };
    TestBed.configureTestingModule({ providers: [DialogService, { provide: NgbModal, useValue: modal }] });
    const service = TestBed.inject(DialogService);
    service.confirm({ title: 'Delete?', content: 'This cannot be undone', injected: 'x' } as any);
    expect(modal.open.calls.mostRecent().args[0]).toBe(ConfirmationDialogComponent);
    expect(instance['title']).toBe('Delete?');
    expect(instance['content']).toBe('This cannot be undone');
    expect('injected' in instance).toBeFalse();
  });
});
