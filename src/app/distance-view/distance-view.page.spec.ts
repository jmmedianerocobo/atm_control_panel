import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DistanceViewPage } from './distance-view.page_dual_relay';

describe('DistanceViewPage', () => {
  let component: DistanceViewPage;
  let fixture: ComponentFixture<DistanceViewPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(DistanceViewPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
