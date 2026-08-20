import { Injectable } from '@angular/core';
import { AlertController } from '@ionic/angular/standalone';

// Fix: en el tablet real de este proyecto (WebView del sistema), CUALQUIER
// forma de <ion-toast> resultó invisible en la práctica, aunque se activaba
// de verdad por debajo (confirmado con Chrome DevTools Protocol,
// inspeccionando el shadow DOM en directo) — declarativo, ToastController
// imperativo, y hasta creando el elemento a mano con
// document.createElement() e insertándolo directamente en <ion-app>: en los
// tres casos, disparado desde un toque real, el "toast-wrapper" nunca
// llegaba a renderizarse (a veces ni siquiera existía en el shadow DOM).
// AlertController SÍ se ve bien en este mismo dispositivo con toda certeza
// (usado para confirmaciones en auto-config/bt-settings/distance-view) — se
// reutiliza como sustituto de "toast", con auto-cierre para no exigir que el
// usuario lo cierre a mano. Antes esto vivía duplicado, literal, en
// auto-config.page.ts y bt-settings.page.ts.
@Injectable({ providedIn: 'root' })
export class ToastService {
  constructor(private alertController: AlertController) {}

  async present(message: string, color: 'success' | 'danger'): Promise<void> {
    const alert = await this.alertController.create({
      message,
      cssClass: color === 'success' ? 'toast-alert toast-alert-success' : 'toast-alert toast-alert-danger',
      backdropDismiss: true,
    });
    await alert.present();
    setTimeout(() => alert.dismiss().catch(() => {}), color === 'success' ? 2200 : 3200);
  }
}
