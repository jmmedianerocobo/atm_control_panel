import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  IonHeader, IonToolbar, IonTitle,
  IonButtons, IonBackButton,
  IonContent, IonLabel,
  IonButton, IonToggle, IonIcon, IonToast, IonChip,
  AlertController
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
    IonButton, IonToggle, IonIcon, IonToast, IonChip,
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

  showSuccessToast = false;
  successMessage   = 'Configuración aplicada correctamente';
  showErrorToast   = false;
  errorMessage     = '';
  saving           = false;
  calibrating      = false;
  calibratingFull  = false;
  calibratingTiltRef   = false;
  calibratingTiltApply = false;
  calibratingHpZero = false;
  calibratingHpRef  = false;

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

  // v14: calibración de 2 puntos del sensor de ALTA presión (línea/bomba).
  highPressureZeroCalibrated$ = this.bt.highPressureZeroCalibrated$;
  highPressureRefCalibrated$  = this.bt.highPressureRefCalibrated$;

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

  toggleSourceMode(ev: any) { this.sourceMode = ev.detail.checked ? 1 : 0; }
  toggleMode(ev: any)       { this.mode       = ev.detail.checked ? 1 : 0; }

  step(param: string, amount: number) {
    const current  = (this as any)[param];
    const newValue = (Number(current) || 0) + amount;

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

      const err = this.validateConfig();
      if (err) throw new Error(err);

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
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`No se pudo aplicar la configuración general: ${msg}`);
      }

      try {
        await this.bt.setTankGeometry(this.tankHeightMm, this.bt.sensorLongitudinalOffsetMm$.value);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`No se pudo aplicar la geometría del depósito: ${msg}`);
      }

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
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`No se pudieron aplicar los límites de alta presión: ${msg}`);
      }

      await this.saveLocalParams();

      this.successMessage = 'Configuración aplicada correctamente';
      this.showSuccessToast = true;

    } catch (err) {
      this.errorMessage   = err instanceof Error ? err.message : String(err);
      this.showErrorToast = true;
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
      this.errorMessage = 'Conecta primero el dispositivo Bluetooth';
      this.showErrorToast = true;
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
      this.successMessage = 'Nivel vacío calibrado correctamente (cero de presión + plano MPU6050)';
      this.showSuccessToast = true;
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.showErrorToast = true;
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
      this.errorMessage = 'Conecta primero el dispositivo Bluetooth';
      this.showErrorToast = true;
      return;
    }

    if (!this.bt.levelCalibrated$.value) {
      this.errorMessage = 'Calibra primero el nivel vacío';
      this.showErrorToast = true;
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
      this.successMessage = 'Nivel lleno calibrado correctamente';
      this.showSuccessToast = true;
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.showErrorToast = true;
    } finally {
      this.calibratingFull = false;
    }
  }

  // ── Autocalibración de la posición del sensor por inclinación ───
  /**
   * v13: paso 1. Requiere vacío+lleno ya calibrados (el firmware necesita
   * el gradiente presión/mm) y equipo nivelado y quieto — cualquier nivel
   * de llenado vale, pero no debe cambiar hasta terminar el paso 2.
   */
  async confirmTiltReferenceCalibration(): Promise<void> {
    if (!this.bt.isConnected$.value) {
      this.errorMessage = 'Conecta primero el dispositivo Bluetooth';
      this.showErrorToast = true;
      return;
    }
    if (!this.bt.levelCalibrated$.value || !this.bt.levelFullCalibrated$.value) {
      this.errorMessage = 'Calibra primero el nivel vacío y lleno';
      this.showErrorToast = true;
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
      this.successMessage = 'Referencia capturada — ahora inclina el equipo y pulsa "Calcular distancia"';
      this.showSuccessToast = true;
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.showErrorToast = true;
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
      this.errorMessage = 'Conecta primero el dispositivo Bluetooth';
      this.showErrorToast = true;
      return;
    }
    if (!this.bt.tiltCalRefCaptured$.value) {
      this.errorMessage = 'Captura primero la referencia (paso 1)';
      this.showErrorToast = true;
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
      this.successMessage = `Distancia calculada y guardada: ${this.bt.sensorLongitudinalOffsetMm$.value} mm`;
      this.showSuccessToast = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage = msg.includes('BAD_VALUE')
        ? 'Inclinación insuficiente respecto al paso 1 — inclina más y vuelve a pulsar "Calcular distancia"'
        : msg;
      this.showErrorToast = true;
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
      this.errorMessage = 'Conecta primero el dispositivo Bluetooth';
      this.showErrorToast = true;
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
      this.successMessage = 'Cero de alta presión calibrado correctamente';
      this.showSuccessToast = true;
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.showErrorToast = true;
    } finally {
      this.calibratingHpZero = false;
    }
  }

  /**
   * v14: paso 2. Pide al usuario el valor de una presión de referencia REAL
   * que debe estar aplicando en ese momento (bomba de mano, manómetro
   * patrón externo, etc.) — el firmware no puede medir esa referencia por
   * su cuenta, solo la cuenta ADC correspondiente a lo que le diga el
   * usuario. Requiere haber calibrado antes el cero.
   */
  async confirmHpRefCalibration(): Promise<void> {
    if (!this.bt.isConnected$.value) {
      this.errorMessage = 'Conecta primero el dispositivo Bluetooth';
      this.showErrorToast = true;
      return;
    }
    if (!this.bt.highPressureZeroCalibrated$.value) {
      this.errorMessage = 'Calibra primero el cero de alta presión';
      this.showErrorToast = true;
      return;
    }

    const alert = await this.alertController.create({
      header: 'Calibrar alta presión — referencia',
      message: 'Aplica una presión conocida (bomba de mano, manómetro patrón, etc.) y escribe aquí su valor real en bar.',
      backdropDismiss: false,
      inputs: [
        { name: 'refBar', type: 'number', placeholder: 'Ej. 10.0', min: 0.1, max: 60 },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Calibrar',
          role: 'confirm',
          handler: (data: { refBar?: string }) => {
            const refBar = parseFloat(data?.refBar ?? '');
            if (!isFinite(refBar) || refBar <= 0) {
              this.errorMessage = 'Introduce un valor de presión válido, mayor que 0';
              this.showErrorToast = true;
              return false;
            }
            void this.runHpRefCalibration(refBar);
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  private async runHpRefCalibration(refBar: number): Promise<void> {
    if (this.calibratingHpRef) return;
    this.calibratingHpRef = true;
    try {
      await this.bt.calibrateHighPressureRef(refBar);
      this.successMessage = `Referencia de alta presión calibrada (${refBar} bar)`;
      this.showSuccessToast = true;
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.showErrorToast = true;
    } finally {
      this.calibratingHpRef = false;
    }
  }

  async startLeft() {
    try {
      if (this.bt.mode$.value !== 1) {
        this.errorMessage   = 'Solo disponible en modo temporizado';
        this.showErrorToast = true;
        return;
      }
      await this.bt.testTrigger('L');
    } catch (e) {
      this.errorMessage   = e instanceof Error ? e.message : String(e);
      this.showErrorToast = true;
    }
  }

  async startRight() {
    try {
      if (this.bt.mode$.value !== 1) {
        this.errorMessage   = 'Solo disponible en modo temporizado';
        this.showErrorToast = true;
        return;
      }
      await this.bt.testTrigger('R');
    } catch (e) {
      this.errorMessage   = e instanceof Error ? e.message : String(e);
      this.showErrorToast = true;
    }
  }

  async stopAll() {
    try {
      await this.bt.emergencyStop();
    } catch (e) {
      this.errorMessage   = e instanceof Error ? e.message : String(e);
      this.showErrorToast = true;
    }
  }
}
