import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { LoginComponent } from './login.component';
import { ClerkService } from 'src/app/core/services/clerk.service';

describe('LoginComponent', () => {
  it('can be created with its dependencies', () => {
    TestBed.configureTestingModule({
      declarations: [LoginComponent],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [
        { provide: ClerkService, useValue: { loaded: true, mountSignIn: () => undefined, unmount: () => undefined } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    });
    expect(TestBed.createComponent(LoginComponent).componentInstance).toBeTruthy();
  });
});
