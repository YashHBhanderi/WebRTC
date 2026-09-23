import { ComponentFixture, TestBed } from '@angular/core/testing';

import { JistiMeetComponent } from './jisti-meet.component';

describe('JistiComponent', () => {
  let component: JistiMeetComponent;
  let fixture: ComponentFixture<JistiMeetComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [JistiMeetComponent]
    });
    fixture = TestBed.createComponent(JistiMeetComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
