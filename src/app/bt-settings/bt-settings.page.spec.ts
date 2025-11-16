import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BtSettingsPage } from './bt-settings.page';

describe('BtSettingsPage', () => {
  let component: BtSettingsPage;
  let fixture: ComponentFixture<BtSettingsPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(BtSettingsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
