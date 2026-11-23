import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { RegisterComponent } from './register.component';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { clearPortal } from 'src/app/core/services/portal';

describe('RegisterComponent', () => {
  afterEach(() => clearPortal());

  it('signs up into the portal named in the link', () => {
    const mountSignUp = jasmine.createSpy('mountSignUp');
    TestBed.configureTestingModule({
      declarations: [RegisterComponent],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [
        { provide: ClerkService, useValue: { loaded: true, mountSignUp, unmount: () => undefined } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ portal: 'developer' }) } } },
      ],
    });
    const fixture = TestBed.createComponent(RegisterComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.portal).toBe('developer');
    expect(mountSignUp).toHaveBeenCalledWith(jasmine.anything(), '/developer');
  });
});
