import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {     
  IonHeader, IonToolbar, IonTitle,
  IonButtons, IonBackButton,
  IonContent, IonList, IonItem,
  IonLabel, IonNote, IonButton,
  IonToggle, IonIcon
} from '@ionic/angular/standalone';

import { BluetoothService } from '../services/bluetooth.service';

@Component({
  selector: 'app-auto-config',
  templateUrl: './auto-config.page.html',
  styleUrls: ['./auto-config.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader, IonToolbar, IonTitle,
    IonButtons, IonBackButton,
    IonContent, IonList, IonItem,
    IonLabel, IonNote, IonButton,
    IonToggle, IonIcon
  ]
})
export class AutoConfigPage {

  /* ================================
      VALORES PRINCIPALES
  ================================= */
  mode: 0 | 1 = 0;

  // MODO DISTANCIA
  retardoEntradaDist = 200;
  retardoSalidaDist = 250;
  litersPerMin = 10;
  numApplicators = 2;

  // MODO TEMPORIZADO
  retardoEntradaTemp = 200;
  activeTimeMs = 300;

  // LECTURA
  thresholdCm = 0;
  hysteresisCm = 0;
  holdTimeMs = 0;

  constructor(public bt: BluetoothService) {}

  ionViewWillEnter() {
    this.thresholdCm   = this.bt.thresholdCm$.value;
    this.hysteresisCm  = this.bt.hysteresisCm$.value;
    this.holdTimeMs    = this.bt.holdTimeMs$.value;
  }

  /* ================================
      STEPPER GENÉRICO
  ================================= */
  step(param: string, amount: number) {
    (this as any)[param] = Math.max(
      0,
      (this as any)[param] + amount
    );
  }

  /* ================================
      TOGGLE MODO
  ================================= */
  toggleMode(ev: any) {
    this.mode = ev.detail.checked ? 1 : 0;
    this.bt.setMode(this.mode);
  }

  /* ================================
      GUARDAR CONFIGURACIÓN
  ================================= */
  applyConfig() {

    // valores comunes
    this.bt.setThresholdCm(this.thresholdCm);
    this.bt.setHysteresisCm(this.hysteresisCm);
    this.bt.setHoldTimeMs(this.holdTimeMs);
    this.bt.setMode(this.mode);

    this.bt.setRetardoEntradaDist(this.retardoEntradaDist);
    this.bt.setRetardoSalidaDist(this.retardoSalidaDist);
    this.bt.setLitersPerMin(this.litersPerMin);
    this.bt.setNumApplicators(this.numApplicators);


    console.log("=== CONFIGURACIÓN ENVIADA ===");
    console.log("Retardo entrada (dist) =", this.retardoEntradaDist);
    console.log("Retardo salida (dist)  =", this.retardoSalidaDist);
    console.log("Litros/min =", this.litersPerMin);
    console.log("Aplicadores =", this.numApplicators);
    console.log("Retardo entrada (temp) =", this.retardoEntradaTemp);
    console.log("Temporizador apertura =", this.activeTimeMs);
  }

}
