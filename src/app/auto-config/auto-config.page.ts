import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonHeader, IonToolbar, IonTitle,
  IonButtons, IonBackButton,
  IonContent, IonList, IonItem,
  IonLabel, IonNote, IonButton,
  IonToggle
} from '@ionic/angular/standalone';

import { PickerController } from '@ionic/angular';
import { BluetoothService } from '../services/bluetooth.service';

@Component({
  selector: 'app-auto-config',
  templateUrl: './auto-config.page.html',
  styleUrls: ['./auto-config.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    IonHeader, IonToolbar, IonTitle,
    IonButtons, IonBackButton,
    IonContent, IonList, IonItem,
    IonLabel, IonNote, IonButton,
    IonToggle
  ]
})
export class AutoConfigPage {

  thresholdCm = 0;
  hysteresisCm = 0;
  holdTimeMs = 0;
  activeTimeMs = 0;
  mode: 0 | 1 = 0;

  litersPerMin = 10;        // NUEVO
  numApplicators = 2;       // NUEVO

  constructor(
    private pickerCtrl: PickerController,
    private bt: BluetoothService
  ) {}

  ionViewWillEnter() {
    this.thresholdCm   = this.bt.thresholdCm$.value;
    this.hysteresisCm  = this.bt.hysteresisCm$.value;
    this.holdTimeMs    = this.bt.holdTimeMs$.value;

    // valores por defecto configurables
    this.activeTimeMs  = 300;
    this.mode          = 0;

    // valores nuevos
    this.litersPerMin  = 10;
    this.numApplicators = 2;
  }

  // =====================================================
  //        TOGGLE MODO (0 ↔ 1)
  // =====================================================
  toggleMode(ev: any) {
    const checked = ev.detail.checked;
    this.mode = checked ? 1 : 0;

    console.log("[AUTO] Modo cambiado a", this.mode);

    // enviar al Arduino
    this.bt.setMode(this.mode);
  }

  // =====================================================
  //        PICKER (paso 25)
  // =====================================================
  async openPicker(type: string) {
    let columns: any[] = [];

    switch (type) {

      case 'threshold':
        columns = [{
          name: 'value',
          options: Array.from({ length: 9 }, (_, i) => {
            const v = i * 25;
            return { text: `${v} cm`, value: v };
          })
        }];
        break;

      case 'hysteresis':
        columns = [{
          name: 'value',
          options: Array.from({ length: 5 }, (_, i) => {
            const v = i * 25;
            return { text: `${v} cm`, value: v };
          })
        }];
        break;

      case 'hold':
        columns = [{
          name: 'value',
          options: Array.from({ length: 41 }, (_, i) => {
            const v = i * 25;
            return { text: `${v} ms`, value: v };
          })
        }];
        break;

      case 'active':
        columns = [{
          name: 'value',
          options: Array.from({ length: 81 }, (_, i) => {
            const v = i * 25;
            return { text: `${v} ms`, value: v };
          })
        }];
        break;

      case 'liters':  // NUEVO
        columns = [{
          name: 'value',
          options: Array.from({ length: 40 }, (_, i) => {
            const v = (i + 1); // 1–40 L/min
            return { text: `${v} L/min`, value: v };
          })
        }];
        break;

      case 'applicators':  // NUEVO
        columns = [{
          name: 'value',
          options: Array.from({ length: 20 }, (_, i) => {
            const v = i + 1; // 1–20 aplicadores
            return { text: `${v}`, value: v };
          })
        }];
        break;
    }

    const picker = await this.pickerCtrl.create({
      columns,
      buttons: [
        { text: "Cancelar", role: "cancel" },
        {
          text: "Aceptar",
          handler: (value) => {
            const val = Number(value?.value?.value ?? 0);

            switch (type) {
              case 'threshold':
                this.thresholdCm = val;
                if (this.mode === 0) {
                  this.bt.setThresholdCm(this.thresholdCm);
                }
                break;

              case 'hysteresis':
                this.hysteresisCm = val;
                break;

              case 'hold':
                this.holdTimeMs = val;
                break;

              case 'active':
                this.activeTimeMs = val;
                break;

              case 'liters':   // NUEVO
                this.litersPerMin = val;
                break;

              case 'applicators': // NUEVO
                this.numApplicators = val;
                break;
            }
          }
        }
      ]
    });

    await picker.present();
  }

  // =====================================================
  //        APLICAR CONFIGURACIÓN
  // =====================================================
  applyConfig() {
    this.bt.setThresholdCm(this.thresholdCm);
    this.bt.setHysteresisCm(this.hysteresisCm);
    this.bt.setHoldTimeMs(this.holdTimeMs);
    this.bt.setActiveTimeMs(this.activeTimeMs);
    this.bt.setMode(this.mode);

    console.log("L/min =", this.litersPerMin);
    console.log("Aplicadores =", this.numApplicators);
  }
}
