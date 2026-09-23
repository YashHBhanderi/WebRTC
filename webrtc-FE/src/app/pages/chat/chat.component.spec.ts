import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ChatNewComponent } from './chat.component';

describe('ChatNewComponent', () => {
  let component: ChatNewComponent;
  let fixture: ComponentFixture<ChatNewComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [ChatNewComponent]
    });
    fixture = TestBed.createComponent(ChatNewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
