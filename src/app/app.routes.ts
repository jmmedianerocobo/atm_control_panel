/*import { Routes } from '@angular/router';

export const routes: Routes = [
 
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
  {
    path: 'auto-config',
    loadComponent: () => import('./auto-config/auto-config.page').then( m => m.AutoConfigPage)
  },

];*/

import { Routes } from '@angular/router';

export const routes: Routes = [

  // Página por defecto → distance-view
  {
    path: '',
    redirectTo: 'distance-view',
    pathMatch: 'full',
  },

  // ⭐ ESTA es tu página principal
  {
    path: 'distance-view',
    loadComponent: () =>
      import('./distance-view/distance-view.page').then(m => m.DistanceViewPage)
  },

  // Ajustes BT
  {
    path: 'bt-settings',
    loadComponent: () =>
      import('./bt-settings/bt-settings.page').then((m) => m.BtSettingsPage),
  },

  // Configuración automática
  {
    path: 'auto-config',
    loadComponent: () =>
      import('./auto-config/auto-config.page').then(m => m.AutoConfigPage)
  },

];
