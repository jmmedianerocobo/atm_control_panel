import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  IonHeader, IonToolbar, IonTitle,
  IonButtons, IonBackButton,
  IonContent, IonList, IonItem,
  IonLabel, IonButton,
  IonToggle, IonIcon, IonToast
} from '@ionic/angular/standalone';

import { BluetoothService } from '../services/bluetooth.service';
import { Preferences } from '@capacitor/preferences';

const PREF_LPM  = 'app.litersPerMin';
const PREF_APPS = 'app.numApplicators';

const PREF_GRPS = 'app.grPerSec';



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
    IonLabel, IonButton,
    IonToggle, IonIcon, IonToast
  ]
})
export class AutoConfigPage {

  mode: 0 | 1 = 0;

  // Arduino
  retardoEntradaDist = 0;
  retardoSalidaDist = 0;

  // Solo app
  litersPerMin = 1.0;
  numApplicators = 2;

  // Arduino
  retardoEntradaTemp = 0;
  activeTimeModo1 = 2000;

  // Arduino
  thresholdCm = 50;
  hysteresisCm = 10;

  // Toast
  showSuccessToast = false;
  showErrorToast = false;
  errorMessage = '';

  grPerSec = 100;


  constructor(public bt: BluetoothService) {}

  async ionViewWillEnter() {
    console.log('═══════════════════════════════════════');
    console.log('📍 ionViewWillEnter - INICIO');
    console.log('═══════════════════════════════════════');
    
    console.log('🔍 BehaviorSubjects EN EL SERVICIO:');
    console.log('  - mode$:', this.bt.mode$.value, typeof this.bt.mode$.value);
    console.log('  - thresholdCm$:', this.bt.thresholdCm$.value);
    console.log('  - hysteresisCm$:', this.bt.hysteresisCm$.value);
    console.log('  - retardoEntradaDist$:', this.bt.retardoEntradaDist$.value);
    console.log('  - retardoSalidaDist$:', this.bt.retardoSalidaDist$.value);
    console.log('  - retardoEntradaTemp$:', this.bt.retardoEntradaTemp$.value);
    console.log('  - activeTimeModo1$:', this.bt.activeTimeModo1$.value);
    
    // Cargar valores desde el servicio
    this.retardoEntradaDist = this.bt.retardoEntradaDist$.value;
    this.retardoSalidaDist  = this.bt.retardoSalidaDist$.value;
    this.thresholdCm  = this.bt.thresholdCm$.value;
    this.hysteresisCm = this.bt.hysteresisCm$.value;
    this.retardoEntradaTemp = this.bt.retardoEntradaTemp$.value;
    this.activeTimeModo1    = this.bt.activeTimeModo1$.value;
    
    // ✅ MODO: Cargar desde servicio
    const modoServicio = this.bt.mode$.value;
    this.mode = (modoServicio === 1) ? 1 : 0;

    console.log('');
    console.log('📊 Valores LOCALES después de cargar:');
    console.log('  - this.mode:', this.mode, typeof this.mode);
    console.log('  - this.thresholdCm:', this.thresholdCm);
    console.log('  - this.hysteresisCm:', this.hysteresisCm);

    await this.loadAppParams();
    
    console.log('═══════════════════════════════════════');
    console.log('📍 ionViewWillEnter - FIN');
    console.log('═══════════════════════════════════════');
  }

  private async loadAppParams() {
  const [lpm, apps, grps] = await Promise.all([
    Preferences.get({ key: PREF_LPM }),
    Preferences.get({ key: PREF_APPS }),
    Preferences.get({ key: PREF_GRPS })
  ]);

  this.litersPerMin    = lpm.value  ? Number(lpm.value)  : 1.0;
  this.numApplicators  = apps.value ? Number(apps.value) : 2;
  this.grPerSec        = grps.value ? Number(grps.value) : 100;

  if (!Number.isFinite(this.litersPerMin) || this.litersPerMin < 0) this.litersPerMin = 1.0;
  if (!Number.isFinite(this.numApplicators) || this.numApplicators < 1) this.numApplicators = 2;

  if (!Number.isFinite(this.grPerSec) || this.grPerSec < 0) this.grPerSec = 100;

  this.litersPerMin   = Number(this.litersPerMin.toFixed(1));
  this.numApplicators = Math.round(this.numApplicators);
  this.grPerSec       = Math.round(this.grPerSec);

  // ✅ clave para que DistanceView lo vea
  this.bt.setLitersPerMin(this.litersPerMin);
  this.bt.setNumApplicators(this.numApplicators);
  this.bt.setGrPerSec(this.grPerSec);
}


  private async saveAppParams() {
  await Promise.all([
    Preferences.set({ key: PREF_LPM,  value: String(Number(this.litersPerMin.toFixed(1))) }),
    Preferences.set({ key: PREF_APPS, value: String(Math.round(this.numApplicators)) }),
    Preferences.set({ key: PREF_GRPS, value: String(Math.round(this.grPerSec)) }),
  ]);

  // ✅ clave
  this.bt.setLitersPerMin(this.litersPerMin);
  this.bt.setNumApplicators(this.numApplicators);
  this.bt.setGrPerSec(this.grPerSec);
}



  step(param: string, amount: number) {
    const current = (this as any)[param];
    const newValue = (Number(current) || 0) + amount;

    if (param === 'litersPerMin') {
      const clamped = Math.max(0, newValue);
      (this as any)[param] = Number(clamped.toFixed(1));
      return;
    }

    const clamped = Math.max(0, newValue);
    (this as any)[param] = Math.round(clamped);
  }

  toggleMode(ev: any) {
    const nuevoModo = ev.detail.checked ? 1 : 0;
    this.mode = nuevoModo as 0 | 1;
    
    console.log('═══════════════════════════════════════');
    console.log('🔄 toggleMode');
    console.log('  - Toggle checked:', ev.detail.checked);
    console.log('  - Nuevo modo:', nuevoModo);
    console.log('  - this.mode:', this.mode);
    console.log('═══════════════════════════════════════');
  }

saving = false;

private async waitUntilConfigMatches(
  target: {
    mode: number;
    thresholdCm: number;
    hysteresisCm: number;
    retardoEntradaDist: number;
    retardoSalidaDist: number;
    retardoEntradaTemp: number;
    activeTimeModo1: number;
  },
  timeoutMs: number
): Promise<boolean> {
  const t0 = Date.now();

  while (Date.now() - t0 < timeoutMs) {
    const same =
      this.bt.mode$.value === target.mode &&
      this.bt.thresholdCm$.value === target.thresholdCm &&
      this.bt.hysteresisCm$.value === target.hysteresisCm &&
      this.bt.retardoEntradaDist$.value === target.retardoEntradaDist &&
      this.bt.retardoSalidaDist$.value === target.retardoSalidaDist &&
      this.bt.retardoEntradaTemp$.value === target.retardoEntradaTemp &&
      this.bt.activeTimeModo1$.value === target.activeTimeModo1;

    if (same) return true;

    await new Promise(r => setTimeout(r, 50));
  }

  return false;
}


async applyConfig() {
  if (this.saving) return;              // ✅ evita doble click
  this.saving = true;

  console.log('═══════════════════════════════════════');
  console.log('💾 GUARDAR CONFIGURACIÓN - INICIO');
  console.log('═══════════════════════════════════════');

  const configAEnviar = {
    mode: this.mode,
    thresholdCm: this.thresholdCm,
    hysteresisCm: this.hysteresisCm,
    retardoEntradaDist: this.retardoEntradaDist,
    retardoSalidaDist: this.retardoSalidaDist,
    retardoEntradaTemp: this.retardoEntradaTemp,
    activeTimeModo1: this.activeTimeModo1,
  };

  console.log('📤 Configuración a enviar:', configAEnviar);

  try {
    // 1) Enviar al Arduino
    console.log('1️⃣ Enviando applyConfigOnce...');
    await this.bt.applyConfigOnce(configAEnviar);
    console.log('✅ applyConfigOnce completado (ACK recibido)');

    // 2) ✅ Confirmación real (evita “guardado fantasma”)
    // Espera a que el servicio refleje lo que manda el Arduino por snapshot/status
    // (si tu servicio ya tiene confirmConfigApplied(), úsalo; si no, esta validación es simple)
    const ok = await this.waitUntilConfigMatches(configAEnviar, 2000);
    if (!ok) {
      throw new Error('No se confirmó la config (Arduino sigue reportando valores antiguos)');
    }

    // 3) Guardar parámetros app
    console.log('3️⃣ Guardando parámetros app...');
    await this.saveAppParams();
    console.log('✅ Parámetros app guardados');

    console.log('═══════════════════════════════════════');
    console.log('✅ CONFIGURACIÓN GUARDADA EXITOSAMENTE');
    console.log('═══════════════════════════════════════');

    this.showSuccessToast = true;
  } catch (err) {
    console.error('═══════════════════════════════════════');
    console.error('❌ ERROR AL GUARDAR:', err);
    console.error('═══════════════════════════════════════');

    this.errorMessage = err instanceof Error ? err.message : String(err);
    this.showErrorToast = true;
  } finally {
    this.saving = false;
  }
}
  async startLeft() {
    try {
      if (this.mode !== 1) {
        console.warn('⚠️ Test trigger solo disponible en modo 1');
        console.warn('  - Modo actual:', this.mode);
        return;
      }
      console.log('🔵 startLeft() - Activando relé izquierdo');
      await this.bt.testTrigger('L');
    } catch (e) {
      console.error('❌ Error en startLeft:', e);
    }
  }

  async startRight() {
    try {
      if (this.mode !== 1) {
        console.warn('⚠️ Test trigger solo disponible en modo 1');
        console.warn('  - Modo actual:', this.mode);
        return;
      }
      console.log('🔵 startRight() - Activando relé derecho');
      await this.bt.testTrigger('R');
    } catch (e) {
      console.error('❌ Error en startRight:', e);
    }
  }

  async stopAll() {
    try {
      console.log('🛑 stopAll() - Parada de emergencia');
      await this.bt.emergencyStop();
    } catch (e) {
      console.error('❌ Error en stopAll:', e);
    }
  }
}