import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  IonHeader, IonToolbar, IonTitle,
  IonButtons, IonBackButton,
  IonContent, IonLabel,
  IonButton, IonToggle, IonIcon, IonChip,
  AlertController,
} from '@ionic/angular/standalone';

import { addIcons } from 'ionicons';
import {
  bluetoothOutline,
  closeCircleOutline,
  radioOutline,
  timerOutline,
  pulseOutline,
  chevronDownOutline,
  chevronUpOutline,
  warningOutline,
  stopCircleOutline,
  arrowBackOutline,
  arrowForwardOutline,
  cubeOutline,
  locateOutline,
  speedometerOutline,
  syncOutline,
  checkmarkCircleOutline,
  saveOutline,
} from 'ionicons/icons';

import { BluetoothService, HP_MIN_GAP_BAR } from '../services/bluetooth.service';
import { Preferences } from '@capacitor/preferences';

const PREF_DEPOSITO_CAP = 'cfg.depositoCap';

@Component({
  selector: 'app-auto-config',
  templateUrl: './auto-config.page.html',
  styleUrls: ['./auto-config.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle,
    IonButtons, IonBackButton,
    IonContent, IonLabel,
    IonButton, IonToggle, IonIcon, IonChip,
  ],
})
export class AutoConfigPage {

  sourceMode: 0 | 1 = 0;
  mode: 0 | 1 = 0;

  thresholdCm        = 50;
  hysteresisCm       = 10;
  retardoEntradaDist = 0;
  retardoSalidaDist  = 0;
  retardoEntradaTemp = 0;
  activeTimeModo1    = 2000;

  // v11: geometría del depósito reducida a lo que el firmware realmente usa
  // para calcular el nivel (ver calcularNivel() en el .ino): capacidad (solo
  // local, para convertir % a litros), altura útil y posición longitudinal
  // del sensor de baja presión respecto al centro del depósito. Se elimina
  // el selector de forma (rectangular/cilíndrico/personalizado) y las
  // dimensiones de longitud/anchura/altura-de-montaje-del-sensor/lateral,
  // que nunca llegaban al firmware y no participan en el cálculo real.
  depositoCap           = 2000;
  tankHeightMm           = 300;
  // v14: ya no es editable a mano (ver "Calibrar inclinación" más abajo) —
  // se muestra en modo solo-lectura leyendo directamente el valor real
  // confirmado por el firmware, en vez de un campo local que había que
  // mantener sincronizado. Sigue siendo lo que se manda en setTankGeometry()
  // al aplicar (junto con tankHeightMm, que sí es editable).
  sensorLongitudinalMm$ = this.bt.sensorLongitudinalOffsetMm$;

  // v11: el fondo de escala real del sensor de alta presión es 20 bar
  // (HIGH_PRESSURE_MAX_BAR en el firmware), no 40. El límite superior que
  // puede fijar el usuario se deja HARD_LIMIT_MARGIN_BAR por debajo de ese
  // tope físico, para que siempre quepa el "límite duro" que exige el
  // protocolo (reset < alarma < límite duro <= tope físico) sin necesidad de
  // pedirle ese tercer valor al usuario: se deriva automáticamente como
  // alarma + HARD_LIMIT_MARGIN_BAR (mismo margen que usa el firmware entre
  // sus valores por defecto: 18 → 19.5 bar).
  readonly pressureSensorMaxBar  = 60.0;
  readonly HARD_LIMIT_MARGIN_BAR = 1.5;

  pressureLowLimitBar  = 16.0;
  pressureHighLimitBar = 18.0;

  levelPercent$      = this.bt.levelPercent$;
  levelMm$           = this.bt.levelMm$;
  levelValid$        = this.bt.levelValid$;
  highPressureBar$   = this.bt.highPressureBar$;
  highPressureLockout$     = this.bt.highPressureLockout$;
  highPressureSensorFault$ = this.bt.highPressureSensorFault$;

  saving           = false;

  // Fix UX: antes "Aplicar" reenviaba SIEMPRE los tres comandos (config
  // general, geometría del depósito, límites de alta presión) aunque solo
  // se hubiera tocado un valor de uno de ellos — tres paneles sin relación
  // entre sí forzados por un único botón. Ahora cada grupo se marca "sucio"
  // solo cuando de verdad cambia algo suyo (ver markDirtyFor(), llamado
  // desde step() y promptEditValue()) y applyConfig() solo manda al Arduino
  // los grupos realmente modificados. Se resetean al cargar valores frescos
  // del servicio en ionViewWillEnter(), y cada uno se limpia solo tras
  // aplicarse con éxito (si falla, se queda "sucio" para poder reintentar
  // sin tener que volver a tocar el campo).
  private generalDirty  = false;
  private geometryDirty = false;
  private pressureDirty = false;

  get hasPendingChanges(): boolean {
    return this.generalDirty || this.geometryDirty || this.pressureDirty;
  }

  calibrating      = false;
  calibratingFull  = false;
  calibratingTiltRef   = false;
  calibratingTiltApply = false;
  calibratingHpZero = false;

  // v10 (opción A): CMD_CALIBRATE_LEVEL calibra a la vez el cero de presión
  // (depósito vacío) y el plano del MPU6050.
  levelCalibrated$ = this.bt.levelCalibrated$;

  // v13: autocalibración de sensorLongitudinalOffsetMm por inclinación —
  // true entre el paso 1 (referencia) y el paso 2 (inclinado).
  tiltCalRefCaptured$ = this.bt.tiltCalRefCaptured$;

  // v11: segundo punto de calibración (depósito lleno). Con ambos puntos el
  // firmware calcula el nivel por interpolación de presiones en vez de
  // asumir la densidad del líquido — ver CMD_CALIBRATE_LEVEL_FULL.
  levelFullCalibrated$ = this.bt.levelFullCalibrated$;

  // v14: calibración del cero del sensor de ALTA presión (línea/bomba).
  // v19: ya no se calibra "referencia" desde esta pantalla -- ver nota
  // junto a la eliminación de confirmHpRefCalibration().
  highPressureZeroCalibrated$ = this.bt.highPressureZeroCalibrated$;

  constructor(
    public bt: BluetoothService,
    private alertController: AlertController,
  ) {
    addIcons({
      'bluetooth-outline': bluetoothOutline,
      'close-circle-outline': closeCircleOutline,
      'radio-outline': radioOutline,
      'timer-outline': timerOutline,
      'pulse-outline': pulseOutline,
      'chevron-down-outline': chevronDownOutline,
      'chevron-up-outline': chevronUpOutline,
      'warning-outline': warningOutline,
      'stop-circle-outline': stopCircleOutline,
      'arrow-back-outline': arrowBackOutline,
      'arrow-forward-outline': arrowForwardOutline,
      'cube-outline': cubeOutline,
      'locate-outline': locateOutline,
      'speedometer-outline': speedometerOutline,
      'sync-outline': syncOutline,
      'checkmark-circle-outline': checkmarkCircleOutline,
      'save-outline': saveOutline,
    });
  }

  // Fix: en este tablet concreto (WebView del sistema), CUALQUIER forma de
  // <ion-toast> resultó invisible en la práctica, aunque se activaba de
  // verdad por debajo (confirmado con Chrome DevTools Protocol,
  // inspeccionando el shadow DOM en directo, depurando primero este mismo
  // bug en bt-settings.page.ts) — declarativo, ToastController imperativo,
  // y hasta creando el elemento a mano con document.createElement() e
  // insertándolo directamente en <ion-app>: en los tres casos, disparado
  // desde un toque real, el "toast-wrapper" nunca llegaba a renderizarse.
  // AlertController SÍ se ve bien en este mismo dispositivo con toda
  // certeza (usado en toda esta página) — se reutiliza como sustituto de
  // "toast", con auto-cierre para no exigir que el usuario lo cierre a mano.
  private async presentToast(message: string, color: 'success' | 'danger'): Promise<void> {
    const alert = await this.alertController.create({
      message,
      cssClass: color === 'success' ? 'toast-alert toast-alert-success' : 'toast-alert toast-alert-danger',
      backdropDismiss: true,
    });
    await alert.present();
    setTimeout(() => alert.dismiss().catch(() => {}), color === 'success' ? 2200 : 3200);
  }

  async ionViewWillEnter() {
    this.sourceMode        = this.bt.sourceMode$.value;
    this.mode              = this.bt.mode$.value;
    this.thresholdCm       = this.bt.thresholdCm$.value;
    this.hysteresisCm      = this.bt.hysteresisCm$.value;
    this.retardoEntradaDist = this.bt.retardoEntradaDist$.value;
    this.retardoSalidaDist  = this.bt.retardoSalidaDist$.value;
    this.retardoEntradaTemp = this.bt.retardoEntradaTemp$.value;
    this.activeTimeModo1    = this.bt.activeTimeModo1$.value;

    // v11: geometría del depósito y límites de alta presión ya no son
    // parámetros locales "de adorno" — vienen de BluetoothService, que es
    // quien realmente los envía al firmware (y recuerda el último valor
    // establecido, ver nota en highPressureAlarmBar$ del servicio).
    this.tankHeightMm         = this.bt.tankHeightMm$.value;
    this.pressureLowLimitBar  = this.round1(this.bt.highPressureResetBar$.value);
    this.pressureHighLimitBar = this.round1(this.bt.highPressureAlarmBar$.value);

    // Se acaba de cargar la verdad del servicio: nada está "sucio" todavía.
    this.generalDirty  = false;
    this.geometryDirty = false;
    this.pressureDirty = false;

    await this.loadLocalParams();
  }

  // ================================================================
  // PERSISTENCIA LOCAL (solo capacidad: el resto vive en BluetoothService)
  // ================================================================

  private async loadLocalParams(): Promise<void> {
    const cap = await Preferences.get({ key: PREF_DEPOSITO_CAP });
    if (cap.value) this.depositoCap = Math.max(1, parseInt(cap.value, 10) || 2000);
  }

  private async saveLocalParams(): Promise<void> {
    await Preferences.set({ key: PREF_DEPOSITO_CAP, value: String(this.depositoCap) });
  }

  private round1(v: number): number {
    return Math.round(v * 10) / 10;
  }

  toggleSourceMode(ev: any) { this.sourceMode = ev.detail.checked ? 1 : 0; this.generalDirty = true; }
  toggleMode(ev: any)       { this.mode       = ev.detail.checked ? 1 : 0; this.generalDirty = true; }

  step(param: string, amount: number) {
    const current  = (this as any)[param];
    const newValue = (Number(current) || 0) + amount;
    this.clampAndSet(param, newValue);
    this.markDirtyFor(param);
  }

  /**
   * Marca como "sucio" el grupo (config general / geometría / alta presión)
   * al que pertenece `param`, para que applyConfig() sepa qué comandos
   * tiene de verdad que reenviar. depositoCap no marca ningún grupo: es
   * puramente local (solo Preferences vía saveLocalParams()), nunca se
   * manda al Arduino.
   */
  private markDirtyFor(param: string): void {
    switch (param) {
      case 'thresholdCm':
      case 'hysteresisCm':
      case 'retardoEntradaDist':
      case 'retardoSalidaDist':
      case 'retardoEntradaTemp':
      case 'activeTimeModo1':
        this.generalDirty = true;
        break;
      case 'tankHeightMm':
        this.geometryDirty = true;
        break;
      case 'pressureLowLimitBar':
      case 'pressureHighLimitBar':
        this.pressureDirty = true;
        break;
    }
  }

  /**
   * Aplica el mismo clamp de cordura que antes vivía dentro de step(), pero
   * a partir de un valor ABSOLUTO en vez de un incremento — extraído para
   * que promptEditValue() (entrada numérica directa, ver más abajo) respete
   * exactamente los mismos límites que los steppers +/-, incluidos los
   * cruzados entre pressureLowLimitBar/pressureHighLimitBar. Sin esto,
   * escribir un valor a mano podría dejar los dos límites de presión sin el
   * margen mínimo que exige el firmware.
   */
  private clampAndSet(param: string, newValue: number): void {
    switch (param) {
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
      case 'depositoCap':
        (this as any)[param] = Math.max(1, Math.min(10000, Math.round(newValue)));
        break;
      case 'tankHeightMm':
        // Límites de cordura física, iguales a los que valida el firmware.
        (this as any)[param] = Math.max(100, Math.min(5000, Math.round(newValue)));
        break;

      case 'pressureLowLimitBar': {
        const maxAllowed = this.pressureHighLimitBar - HP_MIN_GAP_BAR;
        this.pressureLowLimitBar = Math.max(
          0,
          Math.min(maxAllowed, this.round1(newValue))
        );
        break;
      }

      case 'pressureHighLimitBar': {
        const minAllowed = this.pressureLowLimitBar + HP_MIN_GAP_BAR;
        // El límite superior se queda HARD_LIMIT_MARGIN_BAR por debajo del
        // tope físico del sensor, para que el "límite duro" derivado
        // (alarma + margen) siempre quepa dentro del rango del sensor.
        const maxAllowed = this.pressureSensorMaxBar - this.HARD_LIMIT_MARGIN_BAR;
        this.pressureHighLimitBar = Math.max(
          minAllowed,
          Math.min(maxAllowed, this.round1(newValue))
        );
        break;
      }

      default:
        (this as any)[param] = Math.max(0, Math.round(newValue));
    }
  }

  /**
   * Fix UX: los steppers +/- son perfectos para ajustes finos, pero para la
   * puesta en marcha inicial (o corregir un valor muy alejado) suponen
   * decenas de toques — llegar de 5 a 300 cm en pasos de 5 son hasta 59
   * toques, la capacidad del depósito en pasos de 50 L otro tanto. Tocar el
   * propio valor (no los botones +/-) abre un teclado numérico para
   * escribirlo directamente. Pasa por el MISMO clamp que step()
   * (clampAndSet), así que nunca puede dejar un valor fuera de rango ni
   * incoherente con el relacionado (p.ej. los límites de presión).
   *
   * `scale` convierte entre el valor mostrado y el almacenado para los
   * parámetros guardados en ms pero mostrados en segundos (p.ej.
   * scale=0.001 para retardoEntradaDist): mostrado = almacenado × scale.
   */
  async promptEditValue(param: string, label: string, unit: string, scale: number = 1): Promise<void> {
    const stored = Number((this as any)[param]) || 0;
    const displayValue = scale === 1 ? stored : Math.round(stored * scale * 100) / 100;

    const alert = await this.alertController.create({
      header: label,
      inputs: [{
        name: 'value',
        type: 'number',
        value: displayValue,
        placeholder: unit,
      }],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Aceptar',
          role: 'confirm',
          handler: (data: { value: string }) => {
            const typed = Number(data?.value);
            // Entrada no numérica o vacía: se deja el diálogo abierto (return
            // false) en vez de aplicar cualquier cosa o cerrarlo en silencio
            // dando la falsa impresión de que se guardó.
            if (!Number.isFinite(typed)) return false;
            const raw = scale === 1 ? typed : typed / scale;
            this.clampAndSet(param, raw);
            this.markDirtyFor(param);
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  private validateConfig(): string | null {
    if (!(this.sourceMode === 0 || this.sourceMode === 1))
      return 'Fuente de disparo inválida';
    if (!(this.mode === 0 || this.mode === 1))
      return 'Modo de funcionamiento inválido';
    if (this.sourceMode === 0) {
      if (this.thresholdCm < 5 || this.thresholdCm > 300)
        return 'Umbral debe estar entre 5 y 300 cm';
      if (this.hysteresisCm < 0 || this.hysteresisCm > 100)
        return 'Histéresis debe estar entre 0 y 100 cm';
    }
    if (this.retardoEntradaDist < 0 || this.retardoEntradaDist > 60000)
      return 'Retardo entrada debe estar entre 0 y 60000 ms';
    if (this.retardoSalidaDist < 0 || this.retardoSalidaDist > 60000)
      return 'Retardo salida debe estar entre 0 y 60000 ms';
    if (this.retardoEntradaTemp < 0 || this.retardoEntradaTemp > 60000)
      return 'Retardo entrada modo 1 debe estar entre 0 y 60000 ms';
    if (this.activeTimeModo1 < 0 || this.activeTimeModo1 > 600000)
      return 'Tiempo activo debe estar entre 0 y 600000 ms';

    if (this.depositoCap < 1 || this.depositoCap > 10000)
      return 'La capacidad debe estar entre 1 y 10000 litros';
    if (this.tankHeightMm < 100 || this.tankHeightMm > 5000)
      return 'La altura del depósito debe estar entre 100 y 5000 mm';

    const derivedHardLimit = Math.min(
      this.pressureSensorMaxBar,
      this.pressureHighLimitBar + this.HARD_LIMIT_MARGIN_BAR
    );
    if (!(this.pressureLowLimitBar >= 0 &&
          (this.pressureHighLimitBar - this.pressureLowLimitBar) >= HP_MIN_GAP_BAR &&
          (derivedHardLimit - this.pressureHighLimitBar) >= HP_MIN_GAP_BAR &&
          derivedHardLimit <= this.pressureSensorMaxBar)) {
      return `Los límites de presión deben cumplir: 0 ≤ mínimo, margen ≥ ${HP_MIN_GAP_BAR} bar y máximo ≤ ${this.pressureSensorMaxBar - this.HARD_LIMIT_MARGIN_BAR} bar`;
    }

    return null;
  }

  async applyConfig() {
    if (this.saving) return;
    this.saving = true;

    try {
      if (!this.bt.isConnected$.value) {
        throw new Error('Conecta primero el dispositivo Bluetooth');
      }

      // Fix UX: antes se mandaban SIEMPRE los tres comandos aunque el
      // usuario solo hubiera tocado un valor de uno de los tres grupos —
      // ver la nota junto a generalDirty/geometryDirty/pressureDirty más
      // arriba. Sin cambios pendientes no hay nada que reenviar (el botón
      // ya está deshabilitado en este caso vía hasPendingChanges, esto es
      // la misma guarda por si se llama a applyConfig() desde otro sitio
      // en el futuro) — se comprueba DESPUÉS de la conexión a propósito:
      // "conecta primero" debe seguir avisando aunque no haya nada sucio.
      if (!this.hasPendingChanges) return;

      const err = this.validateConfig();
      if (err) throw new Error(err);

      if (this.generalDirty) {
        try {
          await this.bt.applyConfigOnce({
            sourceMode:        this.sourceMode,
            mode:              this.mode,
            thresholdCm:       this.thresholdCm,
            hysteresisCm:      this.hysteresisCm,
            retardoEntradaDist: this.retardoEntradaDist,
            retardoSalidaDist:  this.retardoSalidaDist,
            retardoEntradaTemp: this.retardoEntradaTemp,
            activeTimeModo1:    this.activeTimeModo1,
          });
          this.generalDirty = false;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`No se pudo aplicar la configuración general: ${msg}`);
        }
      }

      if (this.geometryDirty) {
        try {
          await this.bt.setTankGeometry(this.tankHeightMm, this.bt.sensorLongitudinalOffsetMm$.value);
          this.geometryDirty = false;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`No se pudo aplicar la geometría del depósito: ${msg}`);
        }
      }

      if (this.pressureDirty) {
        try {
          const derivedHardLimit = Math.min(
            this.pressureSensorMaxBar,
            this.pressureHighLimitBar + this.HARD_LIMIT_MARGIN_BAR
          );
          await this.bt.setHighPressureConfig(
            this.pressureHighLimitBar,
            this.pressureLowLimitBar,
            derivedHardLimit,
          );
          this.pressureDirty = false;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`No se pudieron aplicar los límites de alta presión: ${msg}`);
        }
      }

      await this.saveLocalParams();

      await this.presentToast('Configuración aplicada correctamente', 'success');

    } catch (err) {
      await this.presentToast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      this.saving = false;
    }
  }

  // ── Calibración de nivel (2 puntos: vacío + lleno) ──────────────
  /**
   * v11: paso 1, vacío. CMD_CALIBRATE_LEVEL calibra a la vez el cero del
   * sensor de presión (depósito vacío) y el plano del MPU6050 (equipo
   * inmóvil, en la orientación que se quiera considerar "plana").
   */
  async confirmLevelCalibration(): Promise<void> {
    if (!this.bt.isConnected$.value) {
      await this.presentToast('Conecta primero el dispositivo Bluetooth', 'danger');
      return;
    }

    const alert = await this.alertController.create({
      header: 'Calibrar nivel vacío',
      message:
        'Confirma que el depósito está completamente vacío y que el equipo está ' +
        'detenido, sin vibraciones, en la posición que quieras usar como referencia ' +
        '(normalmente sobre terreno horizontal). Se guardará el cero de presión y ' +
        'el plano del MPU6050 en una sola operación.',
      backdropDismiss: false,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Calibrar', role: 'confirm', handler: () => void this.runLevelCalibration() },
      ],
    });
    await alert.present();
  }

  private async runLevelCalibration(): Promise<void> {
    if (this.calibrating) return;
    this.calibrating = true;

    try {
      await this.bt.calibrateLevel();
      await this.presentToast('Nivel vacío calibrado correctamente (cero de presión + plano MPU6050)', 'success');
    } catch (err) {
      await this.presentToast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      this.calibrating = false;
    }
  }

  /**
   * v11: paso 2, lleno. Requiere haber calibrado antes el vacío — el
   * firmware necesita esa referencia para calcular el gradiente de presión
   * entre ambos puntos. No fija ningún plano del MPU6050, solo la presión.
   */
  async confirmFullLevelCalibration(): Promise<void> {
    if (!this.bt.isConnected$.value) {
      await this.presentToast('Conecta primero el dispositivo Bluetooth', 'danger');
      return;
    }

    if (!this.bt.levelCalibrated$.value) {
      await this.presentToast('Calibra primero el nivel vacío', 'danger');
      return;
    }

    const alert = await this.alertController.create({
      header: 'Calibrar nivel lleno',
      message:
        'Confirma que el depósito está completamente lleno y que el equipo está ' +
        'detenido. Con este segundo punto de referencia, el nivel se calcula por ' +
        'interpolación entre la presión de vacío y la de lleno, sin necesidad de ' +
        'asumir la densidad del líquido.',
      backdropDismiss: false,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Calibrar', role: 'confirm', handler: () => void this.runFullLevelCalibration() },
      ],
    });
    await alert.present();
  }

  private async runFullLevelCalibration(): Promise<void> {
    if (this.calibratingFull) return;
    this.calibratingFull = true;

    try {
      await this.bt.calibrateLevelFull();
      await this.presentToast('Nivel lleno calibrado correctamente', 'success');
    } catch (err) {
      await this.presentToast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      this.calibratingFull = false;
    }
  }

  // ── Autocalibración de la posición del sensor por inclinación ───
  /**
   * v16: paso 1. Requiere el cero de presión (vacío) calibrado — ya NO hace
   * falta "Lleno" primero. El gradiente presión/mm lo da la calibración de
   * 2 puntos si existe, o si no una estimación por densidad asumida (ver
   * psiPerMmEstimate() en el firmware). Además, calibrar con el depósito
   * realmente lleno sería contraproducente: al no poder desplazarse el
   * líquido, la inclinación apenas cambia la presión medida.
   */
  async confirmTiltReferenceCalibration(): Promise<void> {
    if (!this.bt.isConnected$.value) {
      await this.presentToast('Conecta primero el dispositivo Bluetooth', 'danger');
      return;
    }
    if (!this.bt.levelCalibrated$.value) {
      await this.presentToast('Calibra primero el nivel vacío', 'danger');
      return;
    }

    const alert = await this.alertController.create({
      header: 'Calibrar posición del sensor — paso 1',
      message:
        'Deja el equipo nivelado y quieto, con cualquier cantidad de líquido ' +
        '(no hace falta que esté vacío ni lleno). A partir de aquí no añadas ni ' +
        'quites líquido hasta terminar el paso 2.',
      backdropDismiss: false,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Capturar referencia', role: 'confirm', handler: () => void this.runTiltReferenceCalibration() },
      ],
    });
    await alert.present();
  }

  private async runTiltReferenceCalibration(): Promise<void> {
    if (this.calibratingTiltRef) return;
    this.calibratingTiltRef = true;

    try {
      await this.bt.calibrateTiltReference();
      await this.presentToast('Referencia capturada — ahora inclina el equipo y pulsa "Calcular distancia"', 'success');
    } catch (err) {
      await this.presentToast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      this.calibratingTiltRef = false;
    }
  }

  /**
   * v13: paso 2. Se manda tras inclinar el equipo (cualquier ángulo notable,
   * lo mide el MPU) sin haber cambiado el volumen de líquido desde el paso
   * 1. Si el ángulo alcanzado es insuficiente el firmware devuelve
   * BAD_VALUE y conserva la referencia — se puede reintentar inclinando más
   * sin repetir el paso 1.
   */
  async confirmTiltApplyCalibration(): Promise<void> {
    if (!this.bt.isConnected$.value) {
      await this.presentToast('Conecta primero el dispositivo Bluetooth', 'danger');
      return;
    }
    if (!this.bt.tiltCalRefCaptured$.value) {
      await this.presentToast('Captura primero la referencia (paso 1)', 'danger');
      return;
    }

    const alert = await this.alertController.create({
      header: 'Calibrar posición del sensor — paso 2',
      message:
        'Confirma que el equipo está ahora claramente inclinado respecto al paso 1 ' +
        '(no hace falta un ángulo concreto) y quieto, sin haber añadido ni quitado ' +
        'líquido. Se calculará y guardará la distancia del sensor al eje de basculamiento.',
      backdropDismiss: false,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Calcular distancia', role: 'confirm', handler: () => void this.runTiltApplyCalibration() },
      ],
    });
    await alert.present();
  }

  private async runTiltApplyCalibration(): Promise<void> {
    if (this.calibratingTiltApply) return;
    this.calibratingTiltApply = true;

    try {
      await this.bt.calibrateTiltApply();
      await this.presentToast(`Distancia calculada y guardada: ${this.bt.sensorLongitudinalOffsetMm$.value} mm`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.presentToast(
        msg.includes('BAD_VALUE')
          ? 'Inclinación insuficiente respecto al paso 1 — inclina más y vuelve a pulsar "Calcular distancia"'
          : msg,
        'danger',
      );
    } finally {
      this.calibratingTiltApply = false;
    }
  }

  /**
   * Un solo botón para los dos pasos de la calibración por inclinación: se
   * llama siempre a este único método, y él decide internamente si toca
   * capturar la referencia (paso 1) o calcular (paso 2) según
   * tiltCalRefCaptured$ — así el usuario ve un único bloque en la UI en vez
   * de dos, sin cambiar el protocolo de dos pasos que exige la física (ver
   * conversación de diseño).
   */
  async runTiltCalibrationStep(): Promise<void> {
    if (this.bt.tiltCalRefCaptured$.value) {
      await this.confirmTiltApplyCalibration();
    } else {
      await this.confirmTiltReferenceCalibration();
    }
  }

  // ── Calibración de alta presión (línea/bomba), 2 puntos ─────────
  /**
   * v14: paso 1. Requiere el sensor a presión atmosférica (sin nada de
   * presión aplicada) en el momento de calibrar.
   */
  async confirmHpZeroCalibration(): Promise<void> {
    if (!this.bt.isConnected$.value) {
      await this.presentToast('Conecta primero el dispositivo Bluetooth', 'danger');
      return;
    }

    const alert = await this.alertController.create({
      header: 'Calibrar alta presión — cero',
      message: 'Confirma que el sensor de alta presión (línea/bomba) no tiene ninguna presión aplicada ahora mismo.',
      backdropDismiss: false,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Calibrar', role: 'confirm', handler: () => void this.runHpZeroCalibration() },
      ],
    });
    await alert.present();
  }

  private async runHpZeroCalibration(): Promise<void> {
    if (this.calibratingHpZero) return;
    this.calibratingHpZero = true;
    try {
      await this.bt.calibrateHighPressureZero();
      await this.presentToast('Cero de alta presión calibrado correctamente', 'success');
    } catch (err) {
      await this.presentToast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      this.calibratingHpZero = false;
    }
  }

  // v19: se quita el paso de "Presión ref." (confirmHpRefCalibration/
  // runHpRefCalibration) -- el sensor real es de 0-60 bar, coincide con
  // HIGH_PRESSURE_MAX_BAR del firmware, así que el cero calibrado solo ya
  // da lecturas correctas. bt.calibrateHighPressureRef() se deja en el
  // servicio por si hiciera falta en el futuro (sensor distinto, etc.),
  // solo se quita el botón/flujo de esta pantalla.

  async startLeft() {
    try {
      if (this.bt.mode$.value !== 1) {
        await this.presentToast('Solo disponible en modo temporizado', 'danger');
        return;
      }
      await this.bt.testTrigger('L');
    } catch (e) {
      await this.presentToast(e instanceof Error ? e.message : String(e), 'danger');
    }
  }

  async startRight() {
    try {
      if (this.bt.mode$.value !== 1) {
        await this.presentToast('Solo disponible en modo temporizado', 'danger');
        return;
      }
      await this.bt.testTrigger('R');
    } catch (e) {
      await this.presentToast(e instanceof Error ? e.message : String(e), 'danger');
    }
  }

  async stopAll() {
    try {
      await this.bt.emergencyStop();
    } catch (e) {
      await this.presentToast(e instanceof Error ? e.message : String(e), 'danger');
    }
  }
}
