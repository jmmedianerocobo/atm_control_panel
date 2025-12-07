import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AutoConfigPage } from './auto-config.page';

describe('AutoConfigPage', () => {
  let component: AutoConfigPage;
  let fixture: ComponentFixture<AutoConfigPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(AutoConfigPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
