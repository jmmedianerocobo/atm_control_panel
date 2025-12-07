import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { BluetoothService } from '../services/bluetooth.service';

import { CommonModule, AsyncPipe, DecimalPipe } from '@angular/common';
import {
  IonToggle,
  IonCard, IonCardHeader, IonCardSubtitle, IonCardContent,
  IonHeader, IonToolbar, IonTitle,
  IonContent, IonButtons, IonBackButton,
  IonChip, IonLabel, IonButton, IonIcon
} from '@ionic/angular/standalone';

@Component({
  selector: 'app-distance-view',
  templateUrl: './distance-view.page.html',
  styleUrls: ['./distance-view.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    AsyncPipe,
    DecimalPipe,
    IonToggle,
    IonCard, IonCardHeader, IonCardSubtitle, IonCardContent,
    IonHeader, IonToolbar, IonTitle,
    IonContent, IonButtons, IonBackButton,
    IonChip, IonLabel, IonButton, IonIcon,
  ],
})
export class DistanceViewPage {

  // ==== Observables desde el servicio ====
  distanceLeft$ = this.bt.distanceLeft$;
  distanceRight$ = this.bt.distanceRight$;
  relayLeft$ = this.bt.relayLeft$;
  relayRight$ = this.bt.relayRight$;
  isConnected$ = this.bt.isConnected$;
  thresholdCm$ = this.bt.thresholdCm$;

  // ==== Toggles visuales ====
  toggleLeftActive = true;
  toggleRightActive = true;

  // ============================================================
  // === CAMPOS QUE USA EL HTML (obligatorio para evitar errores)
  // ============================================================

  // Tiempo de apertura (segundos)
  timeOpenLeft = 0;
  timeOpenRight = 0;

  // Número de aperturas (veces que cruzó el umbral)
  openCountLeft = 0;
  openCountRight = 0;

  // Litros consumidos (se actualizarán dinámicamente)
  litersLeft = 0;
  litersRight = 0;

  // ======== Internos de lógica ========
  private wasBelowLeft = false;
  private wasBelowRight = false;

  private timer: any = null;

  // Puedes ajustar este caudal cuando lo conozcas (litros por segundo)
  private FLOW_LPS = 0.20; // ejemplo: 0.20 L/s  (pon aquí tu valor real)

  constructor(
    private router: Router,
    public bt: BluetoothService
  ) {}

  // ============================================================
  // CICLO DE VIDA
  // ============================================================
  ionViewWillEnter() {
    console.log('[DistanceView] entered');

    // Pedir estado real al Arduino al entrar
    if (this.bt.isConnected$.value) {
      this.bt.requestStatus().catch(() => {});
    }

    // Reset de contadores cada vez que abres la pantalla
    this.resetStats();

    // Iniciar timer
    this.startTimer();

    // Detectar cuando cruza el umbral → cuenta como APERTURA
    this.bt.distanceLeft$.subscribe(dist => {
      const th = this.bt.thresholdCm$.value;

      if (dist !== null) {
        if (dist < th && !this.wasBelowLeft) {
          this.openCountLeft++;      // 🔥 nueva apertura
          this.wasBelowLeft = true;
        }
        if (dist >= th) {
          this.wasBelowLeft = false;
        }
      }
    });

    this.bt.distanceRight$.subscribe(dist => {
      const th = this.bt.thresholdCm$.value;

      if (dist !== null) {
        if (dist < th && !this.wasBelowRight) {
          this.openCountRight++;      // 🔥 nueva apertura
          this.wasBelowRight = true;
        }
        if (dist >= th) {
          this.wasBelowRight = false;
        }
      }
    });
  }

  ionViewWillLeave() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ============================================================
  // TIMER DE SEGUNDOS PARA TIEMPO DE APERTURA Y LITROS
  // ============================================================
  private startTimer() {
    if (this.timer) return;

    this.timer = setInterval(() => {
      const th = this.bt.thresholdCm$.value;

      const distL = this.bt.distanceLeft$.value;
      const distR = this.bt.distanceRight$.value;

      // LADO IZQUIERDO
      if (distL !== null && distL < th) {
        this.timeOpenLeft++;
        this.litersLeft = this.timeOpenLeft * this.FLOW_LPS;
      }

      // LADO DERECHO
      if (distR !== null && distR < th) {
        this.timeOpenRight++;
        this.litersRight = this.timeOpenRight * this.FLOW_LPS;
      }

    }, 1000);
  }

  // ============================================================
  // RESET
  // ============================================================
  private resetStats() {
    this.timeOpenLeft = 0;
    this.timeOpenRight = 0;

    this.openCountLeft = 0;
    this.openCountRight = 0;

    this.litersLeft = 0;
    this.litersRight = 0;

    this.wasBelowLeft = false;
    this.wasBelowRight = false;
  }

  // ============================================================
  // NAVEGACIÓN
  // ============================================================
  goToBluetoothSettings() {
    this.router.navigate(['/bt-settings']);
  }

  openConfigPage() {
    this.router.navigate(['/auto-config']);
  }
}

