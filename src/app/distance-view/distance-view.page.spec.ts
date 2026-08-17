import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DistanceViewPage } from './distance-view.page';

describe('DistanceViewPage', () => {
  let component: DistanceViewPage;
  let fixture: ComponentFixture<DistanceViewPage>;

  beforeEach(async () => {
    fixture = TestBed.createComponent(DistanceViewPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
