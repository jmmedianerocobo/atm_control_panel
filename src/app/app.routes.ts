import { Routes } from '@angular/router';

export const routes: Routes = [
  /*{
    path: 'home',
    loadComponent: () => import('./home/home.page').then((m) => m.HomePage),
  },*/
  {
    //path: 'home',
    path: 'bt-settings',
    loadComponent: () => import('./bt-settings/bt-settings.page').then((m) => m.BtSettingsPage),
  },
  {
    path: '',
    redirectTo: 'home',
    pathMatch: 'full',
  },
  {
    path: 'home',
    loadComponent: () => import('./distance-view/distance-view.page').then( m => m.DistanceViewPage)
  },
];
