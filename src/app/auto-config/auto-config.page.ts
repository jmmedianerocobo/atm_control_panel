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

  // MODO TEMPORIZADO (MODE 1)
  activeTimeMs = 300;

  // LECTURA
  thresholdCm = 0;
  hysteresisCm = 0;
  holdTimeMs = 0;

  constructor(public bt: BluetoothService) {}

  ionViewWillEnter() {

    // ------ Valores modo distancia
    this.retardoEntradaDist = this.bt.retardoEntradaDist$.value;
    this.retardoSalidaDist  = this.bt.retardoSalidaDist$.value;
    this.litersPerMin       = this.bt.litersPerMin$.value;
    this.numApplicators     = this.bt.numApplicators$.value;

    // ------ Parámetros lectura
    this.thresholdCm   = this.bt.thresholdCm$.value;
    this.hysteresisCm  = this.bt.hysteresisCm$.value;
    this.holdTimeMs    = this.bt.holdTimeMs$.value;

    // ------ Modo temporizado (MODE 1)
    this.activeTimeMs = this.bt.activeTimeMs$.value;

    // ------ Modo actual
    this.mode = this.bt.mode$.value ?? 0;
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

    // parámetros comunes
    this.bt.setThresholdCm(this.thresholdCm);
    this.bt.setHysteresisCm(this.hysteresisCm);
    this.bt.setHoldTimeMs(this.holdTimeMs);
    this.bt.setMode(this.mode);

    // modo distancia
    this.bt.setRetardoEntradaDist(this.retardoEntradaDist);
    this.bt.setRetardoSalidaDist(this.retardoSalidaDist);
    this.bt.setLitersPerMin(this.litersPerMin);
    this.bt.setNumApplicators(this.numApplicators);

    // modo temporizado
    if (this.mode === 1) {
    this.bt.setActiveTimeMs(this.activeTimeMs);
}


    console.log("=== CONFIGURACIÓN ENVIADA ===");
    console.log("Modo =", this.mode);
    console.log("Threshold =", this.thresholdCm);
    console.log("Histeresis =", this.hysteresisCm);
    console.log("Hold =", this.holdTimeMs);
    console.log("ActiveTimeMs =", this.activeTimeMs);
  }

}
