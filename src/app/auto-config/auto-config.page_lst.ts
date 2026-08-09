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

import { BluetoothService } from '../services/bluetooth.service_lst';

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

  // 🆕 SOURCE MODE: Fuente de disparo
  sourceMode: 0 | 1 = 0;  // 0=sensor ultrasónico, 1=relé digital (D8/D9)

  // ✅ MODO: tipo estricto
  mode: 0 | 1 = 0;  // 0=continuo, 1=pulso

  // Parámetros Arduino
  retardoEntradaDist = 0;
  retardoSalidaDist = 0;
  retardoEntradaTemp = 0;
  activeTimeModo1 = 2000;
  thresholdCm = 50;
  hysteresisCm = 10;

  // Parámetros App
  litersPerMin = 1.0;
  numApplicators = 2;
  grPerSec = 100;

  // Toast
  showSuccessToast = false;
  showErrorToast = false;
  errorMessage = '';

  // ✅ Control de guardado
  saving = false;

  constructor(public bt: BluetoothService) {}

  async ionViewWillEnter() {
    console.log('═══════════════════════════════════════');
    console.log('📍 AUTO-CONFIG: Cargando valores');
    console.log('═══════════════════════════════════════');
    
    // ✅ FUENTE ÚNICA DE VERDAD: Cargar TODO desde el servicio
    this.sourceMode = this.bt.sourceMode$.value;  // 🆕
    this.mode = this.bt.mode$.value;
    this.thresholdCm = this.bt.thresholdCm$.value;
    this.hysteresisCm = this.bt.hysteresisCm$.value;
    this.retardoEntradaDist = this.bt.retardoEntradaDist$.value;
    this.retardoSalidaDist = this.bt.retardoSalidaDist$.value;
    this.retardoEntradaTemp = this.bt.retardoEntradaTemp$.value;
    this.activeTimeModo1 = this.bt.activeTimeModo1$.value;
    
    this.litersPerMin = this.bt.litersPerMin$.value;
    this.numApplicators = this.bt.numApplicators$.value;
    this.grPerSec = this.bt.grPerSec$.value;

    console.log('✅ Valores cargados:', {
      sourceMode: this.sourceMode,
      mode: this.mode,
      thresholdCm: this.thresholdCm,
      litersPerMin: this.litersPerMin,
    });
    console.log('═══════════════════════════════════════');
  }

  // ✅ VALIDACIÓN antes de aplicar
  private validateConfig(): string | null {
    // Validar sourceMode
    if (!(this.sourceMode === 0 || this.sourceMode === 1)) {
      return 'Fuente de disparo inválida';
    }

    // Validar mode
    if (!(this.mode === 0 || this.mode === 1)) {
      return 'Modo de funcionamiento inválido';
    }

    // Validar parámetros de sensor (solo si sourceMode=0)
    if (this.sourceMode === 0) {
      if (this.thresholdCm < 5 || this.thresholdCm > 300) {
        return 'Umbral debe estar entre 5 y 300 cm';
      }
      if (this.hysteresisCm < 0 || this.hysteresisCm > 100) {
        return 'Histéresis debe estar entre 0 y 100 cm';
      }
    }

    // Validar delays
    if (this.retardoEntradaDist < 0 || this.retardoEntradaDist > 60000) {
      return 'Retardo entrada debe estar entre 0 y 60000 ms';
    }
    if (this.retardoSalidaDist < 0 || this.retardoSalidaDist > 60000) {
      return 'Retardo salida debe estar entre 0 y 60000 ms';
    }
    if (this.retardoEntradaTemp < 0 || this.retardoEntradaTemp > 60000) {
      return 'Retardo entrada modo 1 debe estar entre 0 y 60000 ms';
    }
    if (this.activeTimeModo1 < 0 || this.activeTimeModo1 > 600000) {
      return 'Tiempo activo debe estar entre 0 y 600000 ms';
    }
    
    // Validar parámetros app
    if (this.litersPerMin < 0) {
      return 'Litros/min debe ser >= 0';
    }
    if (this.numApplicators < 1) {
      return 'Aplicadores debe ser >= 1';
    }
    if (this.grPerSec < 0) {
      return 'Gramos/seg debe ser >= 0';
    }
    
    return null;
  }

  step(param: string, amount: number) {
    const current = (this as any)[param];
    const newValue = (Number(current) || 0) + amount;

    // ✅ Validación de rangos por parámetro
    switch (param) {
      case 'litersPerMin':
        (this as any)[param] = Math.max(0, Number(newValue.toFixed(1)));
        break;
      
      case 'thresholdCm':
        (this as any)[param] = Math.max(5, Math.min(300, Math.round(newValue)));
        break;
      
      case 'hysteresisCm':
        (this as any)[param] = Math.max(0, Math.min(100, Math.round(newValue)));
        break;
      
      case 'retardoEntradaDist':
      case 'retardoSalidaDist':
      case 'retardoEntradaTemp':
        (this as any)[param] = Math.max(0, Math.min(60000, Math.round(newValue)));
        break;
      
      case 'activeTimeModo1':
        (this as any)[param] = Math.max(0, Math.min(600000, Math.round(newValue)));
        break;
      
      case 'numApplicators':
        (this as any)[param] = Math.max(1, Math.round(newValue));
        break;
      
      case 'grPerSec':
        (this as any)[param] = Math.max(0, Math.round(newValue));
        break;
      
      default:
        (this as any)[param] = Math.max(0, Math.round(newValue));
    }
  }

  // 🆕 Toggle para sourceMode
  toggleSourceMode(ev: any) {
    this.sourceMode = ev.detail.checked ? 1 : 0;
    console.log('🔄 Fuente de disparo cambiada a:', this.sourceMode === 0 ? 'Sensor ultrasónico' : 'Relé digital (D8/D9)');
  }

  toggleMode(ev: any) {
    this.mode = ev.detail.checked ? 1 : 0;
    console.log('🔄 Modo cambiado a:', this.mode === 0 ? 'Continuo' : 'Pulso');
  }

  // ✅ CORRECCIÓN PRINCIPAL: Guardado simplificado y robusto
  async applyConfig() {
    if (this.saving) {
      console.warn('⚠️ Ya hay un guardado en progreso');
      return;
    }
    
    this.saving = true;

    console.log('═══════════════════════════════════════');
    console.log('💾 GUARDAR CONFIGURACIÓN - INICIO');
    console.log('═══════════════════════════════════════');

    try {
      // 1️⃣ Validar ANTES de enviar
      const validationError = this.validateConfig();
      if (validationError) {
        throw new Error(validationError);
      }

      const configAEnviar = {
        sourceMode: this.sourceMode,  // 🆕 Incluir sourceMode
        mode: this.mode,
        thresholdCm: this.thresholdCm,
        hysteresisCm: this.hysteresisCm,
        retardoEntradaDist: this.retardoEntradaDist,
        retardoSalidaDist: this.retardoSalidaDist,
        retardoEntradaTemp: this.retardoEntradaTemp,
        activeTimeModo1: this.activeTimeModo1,
      };

      console.log('📤 Config a enviar:', configAEnviar);

      // 2️⃣ Enviar al Arduino (ya incluye confirmación en el servicio)
      console.log('⏳ Enviando a Arduino...');
      await this.bt.applyConfigOnce(configAEnviar);
      console.log('✅ Arduino confirmó configuración');

      // 3️⃣ Actualizar parámetros app en el servicio
      console.log('⏳ Actualizando parámetros app...');
      this.bt.setLitersPerMin(this.litersPerMin);
      this.bt.setNumApplicators(this.numApplicators);
      this.bt.setGrPerSec(this.grPerSec);

      // 4️⃣ Guardar TODO en Preferences (incluye params Arduino + App)
      console.log('⏳ Guardando en Preferences...');
      await this.bt.saveConfigToPreferences();
      console.log('✅ Guardado en Preferences');

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

  // ✅ Test triggers: usar el valor del SERVICIO, no el local
  async startLeft() {
    try {
      // ✅ Usar el valor del SERVICIO, no el local
      if (this.bt.mode$.value !== 1) {
        console.warn('⚠️ Test trigger solo disponible en modo 1');
        this.errorMessage = 'Función solo disponible en modo pulso (modo 1)';
        this.showErrorToast = true;
        return;
      }
      
      console.log('🔵 Activando relé izquierdo (test)');
      await this.bt.testTrigger('L');
      
    } catch (e) {
      console.error('❌ Error en startLeft:', e);
      this.errorMessage = e instanceof Error ? e.message : String(e);
      this.showErrorToast = true;
    }
  }

  async startRight() {
    try {
      if (this.bt.mode$.value !== 1) {
        console.warn('⚠️ Test trigger solo disponible en modo 1');
        this.errorMessage = 'Función solo disponible en modo pulso (modo 1)';
        this.showErrorToast = true;
        return;
      }
      
      console.log('🔵 Activando relé derecho (test)');
      await this.bt.testTrigger('R');
      
    } catch (e) {
      console.error('❌ Error en startRight:', e);
      this.errorMessage = e instanceof Error ? e.message : String(e);
      this.showErrorToast = true;
    }
  }

  async stopAll() {
    try {
      console.log('🛑 Parada de emergencia');
      await this.bt.emergencyStop();
    } catch (e) {
      console.error('❌ Error en stopAll:', e);
      this.errorMessage = e instanceof Error ? e.message : String(e);
      this.showErrorToast = true;
    }
  }
}