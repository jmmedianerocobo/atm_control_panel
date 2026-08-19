import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { AlertController } from '@ionic/angular/standalone';

import { AutoConfigPage } from './auto-config.page';
import { BluetoothService, HP_MIN_GAP_BAR } from '../services/bluetooth.service';

const PREF_PREFIX = 'CapacitorStorage.';

/**
 * Doble de BluetoothService con solo la superficie que usa esta página
 * (campos/BehaviorSubjects leídos en los inicializadores de campo de
 * AutoConfigPage + los métodos que llama). No es un mock genérico: cada
 * BehaviorSubject arranca en un valor "sano" (conectado, sin calibrar) para
 * que cada test solo tenga que tocar lo que le interesa.
 */
class FakeBluetoothService {
  isConnected$ = new BehaviorSubject<boolean>(true);
  sourceMode$  = new BehaviorSubject<0 | 1>(0);
  mode$        = new BehaviorSubject<0 | 1>(0);

  thresholdCm$        = new BehaviorSubject<number>(50);
  hysteresisCm$       = new BehaviorSubject<number>(10);
  retardoEntradaDist$ = new BehaviorSubject<number>(0);
  retardoSalidaDist$  = new BehaviorSubject<number>(0);
  retardoEntradaTemp$ = new BehaviorSubject<number>(0);
  activeTimeModo1$    = new BehaviorSubject<number>(2000);

  tankHeightMm$               = new BehaviorSubject<number>(300);
  sensorLongitudinalOffsetMm$ = new BehaviorSubject<number>(800);

  highPressureResetBar$ = new BehaviorSubject<number>(16.0);
  highPressureAlarmBar$ = new BehaviorSubject<number>(18.0);

  levelPercent$ = new BehaviorSubject<number | null>(null);
  levelMm$      = new BehaviorSubject<number | null>(null);
  levelValid$   = new BehaviorSubject<boolean>(false);

  highPressureBar$          = new BehaviorSubject<number | null>(null);
  highPressureLockout$      = new BehaviorSubject<boolean>(false);
  highPressureSensorFault$  = new BehaviorSubject<boolean>(false);

  levelCalibrated$            = new BehaviorSubject<boolean>(false);
  tiltCalRefCaptured$         = new BehaviorSubject<boolean>(false);
  levelFullCalibrated$        = new BehaviorSubject<boolean>(false);
  highPressureZeroCalibrated$ = new BehaviorSubject<boolean>(false);

  applyConfigOnce           = jasmine.createSpy('applyConfigOnce').and.resolveTo(undefined);
  setTankGeometry           = jasmine.createSpy('setTankGeometry').and.resolveTo(undefined);
  setHighPressureConfig     = jasmine.createSpy('setHighPressureConfig').and.resolveTo(undefined);
  calibrateLevel            = jasmine.createSpy('calibrateLevel').and.resolveTo(undefined);
  calibrateLevelFull        = jasmine.createSpy('calibrateLevelFull').and.resolveTo(undefined);
  calibrateTiltReference    = jasmine.createSpy('calibrateTiltReference').and.resolveTo(undefined);
  calibrateTiltApply        = jasmine.createSpy('calibrateTiltApply').and.resolveTo(undefined);
  calibrateHighPressureZero = jasmine.createSpy('calibrateHighPressureZero').and.resolveTo(undefined);
  testTrigger                = jasmine.createSpy('testTrigger').and.resolveTo(undefined);
  emergencyStop               = jasmine.createSpy('emergencyStop').and.resolveTo(undefined);
}

/**
 * Doble de AlertController: create() registra cada alerta (con sus opciones
 * y botones) y devuelve un objeto con present()/dismiss() espiados. Esta
 * misma clase sirve tanto para los diálogos de confirmación de calibración
 * (que llevan `header`) como para presentToast() (que no lleva `header` —
 * ver presentToast() en auto-config.page.ts) — eso es lo que se usa en los
 * tests para distinguir "se mostró un toast de error" de "se llegó a abrir
 * el diálogo de confirmación".
 */
class FakeAlertController {
  created: any[] = [];

  create = jasmine.createSpy('create').and.callFake(async (opts: any) => {
    const alert = {
      opts,
      present: jasmine.createSpy('present').and.resolveTo(undefined),
      dismiss: jasmine.createSpy('dismiss').and.resolveTo(undefined),
    };
    this.created.push(alert);
    return alert;
  });

  get lastAlert(): any { return this.created[this.created.length - 1]; }

  /** Diálogos de confirmación (calibraciones) siempre llevan `header`; los
   *  toasts (presentToast) nunca. */
  get confirmDialogs(): any[] { return this.created.filter(a => a.opts.header); }
  get toasts(): any[] { return this.created.filter(a => !a.opts.header); }

  /** Simula que el usuario pulsa el botón de ese `role` en la última alerta
   *  de confirmación creada, y espera a que su handler (fire-and-forget)
   *  termine de verdad. */
  async pressConfirmButton(role: 'confirm' | 'cancel' = 'confirm'): Promise<void> {
    const dialog = this.confirmDialogs[this.confirmDialogs.length - 1];
    const btn = dialog.opts.buttons.find((b: any) => b.role === role);
    btn?.handler?.();
    // Los handlers de los botones son `() => void this.runXxx()` — disparan
    // una promesa sin esperarla (ver nota en runTiltCalibrationStep()), así
    // que hay que dejar un hueco real de cola de eventos para que esa
    // cadena async interna (que solo await-ea spies ya resueltos) termine.
    await new Promise(r => setTimeout(r, 0));
  }

  /** Igual que pressConfirmButton(), pero pasando `data` al handler del
   *  botón 'confirm' — para los diálogos con `inputs` (ver
   *  promptEditValue() en el .ts). Devuelve lo que el propio handler
   *  devuelva: Ionic usa `false` para dejar el diálogo abierto en vez de
   *  cerrarlo (entrada inválida), cualquier otra cosa lo cierra. */
  pressConfirmButtonWithData(data: any): any {
    const dialog = this.confirmDialogs[this.confirmDialogs.length - 1];
    const btn = dialog.opts.buttons.find((b: any) => b.role === 'confirm');
    return btn?.handler?.(data);
  }
}

describe('AutoConfigPage', () => {
  let component: AutoConfigPage;
  let bt: FakeBluetoothService;
  let alertCtrl: FakeAlertController;

  beforeEach(() => {
    localStorage.clear();
    bt = new FakeBluetoothService();
    alertCtrl = new FakeAlertController();

    TestBed.configureTestingModule({
      providers: [
        { provide: BluetoothService, useValue: bt },
        { provide: AlertController, useValue: alertCtrl },
      ],
    });
    component = TestBed.createComponent(AutoConfigPage).componentInstance;
  });

  afterEach(() => localStorage.clear());

  /** Simula "el usuario ha tocado algo en los tres grupos" sin depender de
   *  qué stepper concreto se use — para los tests centrados en el propio
   *  cascade/reentrancia de applyConfig(), no en qué marca sucio cada
   *  campo (eso lo cubre el describe('marcado de cambios pendientes...')). */
  function markAllDirty() {
    (component as any).generalDirty  = true;
    (component as any).geometryDirty = true;
    (component as any).pressureDirty = true;
  }

  it('se crea y renderiza la plantilla sin errores', () => {
    const fixture = TestBed.createComponent(AutoConfigPage);
    expect(() => fixture.detectChanges()).not.toThrow();
  });

  // ================================================================
  describe('step() — steppers +/-', () => {
    it('recorta thresholdCm a [5,300]', () => {
      component.thresholdCm = 298;
      component.step('thresholdCm', 10);
      expect(component.thresholdCm).toBe(300);
      component.thresholdCm = 6;
      component.step('thresholdCm', -100);
      expect(component.thresholdCm).toBe(5);
    });

    it('recorta hysteresisCm a [0,100]', () => {
      component.hysteresisCm = 2;
      component.step('hysteresisCm', -10);
      expect(component.hysteresisCm).toBe(0);
    });

    it('recorta los tres retardos y activeTimeModo1 a [0,60000]/[0,600000]', () => {
      component.retardoEntradaDist = 59995;
      component.step('retardoEntradaDist', 100);
      expect(component.retardoEntradaDist).toBe(60000);

      component.activeTimeModo1 = 599995;
      component.step('activeTimeModo1', 100);
      expect(component.activeTimeModo1).toBe(600000);
    });

    it('recorta tankHeightMm a [100,5000] (mismos límites de cordura que valida el firmware)', () => {
      component.tankHeightMm = 4998;
      component.step('tankHeightMm', 10);
      expect(component.tankHeightMm).toBe(5000);
      component.tankHeightMm = 102;
      component.step('tankHeightMm', -100);
      expect(component.tankHeightMm).toBe(100);
    });

    it('pressureLowLimitBar nunca puede acercarse a menos de HP_MIN_GAP_BAR del límite alto actual', () => {
      component.pressureHighLimitBar = 18.0;
      component.pressureLowLimitBar = 17.6;
      component.step('pressureLowLimitBar', 1); // intenta subir por encima de 17.5 (18 - 0.5)
      expect(component.pressureLowLimitBar).toBe(18.0 - HP_MIN_GAP_BAR);
    });

    it('pressureHighLimitBar respeta el margen mínimo por debajo Y el tope físico menos HARD_LIMIT_MARGIN_BAR por arriba', () => {
      component.pressureLowLimitBar  = 16.0;
      component.pressureHighLimitBar = 16.3;
      component.step('pressureHighLimitBar', -1); // intenta bajar de 16.5 (16 + 0.5)
      expect(component.pressureHighLimitBar).toBe(16.0 + HP_MIN_GAP_BAR);

      component.pressureHighLimitBar = component.pressureSensorMaxBar - component.HARD_LIMIT_MARGIN_BAR - 0.3;
      component.step('pressureHighLimitBar', 1);
      expect(component.pressureHighLimitBar).toBe(component.pressureSensorMaxBar - component.HARD_LIMIT_MARGIN_BAR);
    });
  });

  // ================================================================
  describe('applyConfig()', () => {
    it('sin conexión: no llama a ningún método del servicio y muestra un toast de error', async () => {
      bt.isConnected$.next(false);
      await component.applyConfig();

      expect(bt.applyConfigOnce).not.toHaveBeenCalled();
      expect(component.saving).toBeFalse();
      expect(alertCtrl.toasts.length).toBe(1);
      expect(alertCtrl.toasts[0].opts.message).toContain('Conecta primero');
    });

    it('config inválida (p.ej. thresholdCm fuera de rango con sourceMode=0): no llama a ningún método del servicio', async () => {
      component.sourceMode = 0;
      component.thresholdCm = 999; // fuera de [5,300]
      (component as any).generalDirty = true; // simula haber tocado el campo (ver step()/promptEditValue())
      await component.applyConfig();

      expect(bt.applyConfigOnce).not.toHaveBeenCalled();
      expect(component.saving).toBeFalse();
      expect(alertCtrl.toasts[0].opts.message).toContain('Umbral');
    });

    it('éxito: llama a applyConfigOnce/setTankGeometry/setHighPressureConfig en orden, con el payload esperado, guarda localParams y muestra éxito', async () => {
      component.sourceMode = 0;
      component.mode = 1;
      component.thresholdCm = 80;
      component.tankHeightMm = 450;
      component.pressureLowLimitBar  = 16.0;
      component.pressureHighLimitBar = 18.0;
      component.depositoCap = 3000;
      markAllDirty();

      await component.applyConfig();

      expect(bt.applyConfigOnce).toHaveBeenCalledWith(jasmine.objectContaining({
        sourceMode: 0, mode: 1, thresholdCm: 80,
      }));
      expect(bt.setTankGeometry).toHaveBeenCalledWith(450, bt.sensorLongitudinalOffsetMm$.value);
      // hardLimit derivado = min(60, 18 + 1.5) = 19.5
      expect(bt.setHighPressureConfig).toHaveBeenCalledWith(18.0, 16.0, 19.5);

      expect(localStorage.getItem(PREF_PREFIX + 'cfg.depositoCap')).toBe('3000');
      expect(alertCtrl.toasts[0].opts.message).toContain('correctamente');
      expect(component.saving).toBeFalse();
      expect(component.hasPendingChanges).toBeFalse(); // los tres grupos quedan limpios tras el éxito
    });

    it('si applyConfigOnce falla, NO intenta geometría ni alta presión, y el toast identifica el paso que falló', async () => {
      markAllDirty();
      bt.applyConfigOnce.and.callFake(() => Promise.reject(new Error('sin ACK')));

      await component.applyConfig();

      expect(bt.setTankGeometry).not.toHaveBeenCalled();
      expect(bt.setHighPressureConfig).not.toHaveBeenCalled();
      expect(alertCtrl.toasts[0].opts.message).toContain('configuración general');
      expect(component.saving).toBeFalse();
    });

    it('si setTankGeometry falla, NO intenta alta presión, y el toast identifica el paso que falló', async () => {
      markAllDirty();
      bt.setTankGeometry.and.callFake(() => Promise.reject(new Error('BAD_VALUE')));

      await component.applyConfig();

      expect(bt.applyConfigOnce).toHaveBeenCalled();
      expect(bt.setHighPressureConfig).not.toHaveBeenCalled();
      expect(alertCtrl.toasts[0].opts.message).toContain('geometría');
      expect(component.saving).toBeFalse();
    });

    it('reentrancia: una segunda llamada mientras la primera sigue en curso se ignora sin llamar de nuevo al servicio', async () => {
      markAllDirty();
      let resolveApply!: () => void;
      bt.applyConfigOnce.and.callFake(() => new Promise<void>(res => { resolveApply = res; }));

      const p1 = component.applyConfig();
      expect(component.saving).toBeTrue();
      const p2 = component.applyConfig(); // debe volver de inmediato, sin tocar el servicio otra vez

      resolveApply();
      await p1; await p2;

      expect(bt.applyConfigOnce).toHaveBeenCalledTimes(1);
      expect(component.saving).toBeFalse();
    });
  });

  // ================================================================
  describe('marcado de cambios pendientes (generalDirty/geometryDirty/pressureDirty)', () => {
    it('recién creado, sin cambios pendientes', () => {
      expect(component.hasPendingChanges).toBeFalse();
    });

    it('step() sobre un parámetro de "config general" solo manda applyConfigOnce, no geometría ni presión', async () => {
      component.step('thresholdCm', 5);
      expect(component.hasPendingChanges).toBeTrue();

      await component.applyConfig();

      expect(bt.applyConfigOnce).toHaveBeenCalled();
      expect(bt.setTankGeometry).not.toHaveBeenCalled();
      expect(bt.setHighPressureConfig).not.toHaveBeenCalled();
    });

    it('step() sobre tankHeightMm (geometría) solo manda setTankGeometry', async () => {
      component.step('tankHeightMm', 10);
      await component.applyConfig();

      expect(bt.setTankGeometry).toHaveBeenCalled();
      expect(bt.applyConfigOnce).not.toHaveBeenCalled();
      expect(bt.setHighPressureConfig).not.toHaveBeenCalled();
    });

    it('step() sobre un límite de presión solo manda setHighPressureConfig', async () => {
      component.step('pressureLowLimitBar', -0.5);
      await component.applyConfig();

      expect(bt.setHighPressureConfig).toHaveBeenCalled();
      expect(bt.applyConfigOnce).not.toHaveBeenCalled();
      expect(bt.setTankGeometry).not.toHaveBeenCalled();
    });

    it('depositoCap es puramente local: step() sobre él NO marca ningún grupo como pendiente', () => {
      component.step('depositoCap', 50);
      expect(component.hasPendingChanges).toBeFalse();
    });

    it('toggleSourceMode()/toggleMode() marcan "config general" como pendiente', () => {
      component.toggleSourceMode({ detail: { checked: true } });
      expect(component.hasPendingChanges).toBeTrue();
    });

    it('applyConfig() sin cambios pendientes no llama a ningún método del servicio', async () => {
      await component.applyConfig();
      expect(bt.applyConfigOnce).not.toHaveBeenCalled();
      expect(bt.setTankGeometry).not.toHaveBeenCalled();
      expect(bt.setHighPressureConfig).not.toHaveBeenCalled();
    });

    it('tras aplicar con éxito, el grupo aplicado deja de estar sucio — una segunda pulsación sin más cambios no reenvía nada', async () => {
      component.step('thresholdCm', 5);
      await component.applyConfig();
      expect(bt.applyConfigOnce).toHaveBeenCalledTimes(1);

      await component.applyConfig(); // sin tocar nada más

      expect(bt.applyConfigOnce).toHaveBeenCalledTimes(1); // no ha vuelto a mandarlo
    });

    it('si falla, el grupo se queda sucio — reintentar sin tocar el campo otra vez sí reenvía', async () => {
      component.step('thresholdCm', 5);
      bt.applyConfigOnce.and.callFake(() => Promise.reject(new Error('sin ACK')));
      await component.applyConfig();
      expect(component.hasPendingChanges).toBeTrue(); // sigue sucio, no se perdió el cambio

      bt.applyConfigOnce.and.resolveTo(undefined); // esta vez el enlace responde
      await component.applyConfig();

      expect(bt.applyConfigOnce).toHaveBeenCalledTimes(2);
      expect(component.hasPendingChanges).toBeFalse();
    });

    it('ionViewWillEnter() resetea los tres flags al cargar valores frescos del servicio', async () => {
      component.step('thresholdCm', 5);
      expect(component.hasPendingChanges).toBeTrue();

      await component.ionViewWillEnter();

      expect(component.hasPendingChanges).toBeFalse();
    });
  });

  // ================================================================
  describe('promptEditValue() — entrada numérica directa (alternativa a los steppers +/-)', () => {
    it('pre-rellena el diálogo con el valor actual', async () => {
      component.thresholdCm = 123;
      await component.promptEditValue('thresholdCm', 'Umbral', 'cm');

      expect(alertCtrl.confirmDialogs.length).toBe(1);
      expect(alertCtrl.confirmDialogs[0].opts.inputs[0].value).toBe(123);
    });

    it('convierte el valor mostrado según `scale` (ms almacenados, segundos mostrados)', async () => {
      component.retardoEntradaDist = 5000; // ms
      await component.promptEditValue('retardoEntradaDist', 'Retardo entrada', 'sg', 0.001);

      expect(alertCtrl.confirmDialogs[0].opts.inputs[0].value).toBe(5); // 5000ms -> 5sg mostrados
    });

    it('al confirmar con un valor válido, aplica el mismo clamp que step() y marca el grupo sucio', async () => {
      await component.promptEditValue('thresholdCm', 'Umbral', 'cm');
      const result = alertCtrl.pressConfirmButtonWithData({ value: '999' }); // fuera de rango

      expect(result).toBeTrue();
      expect(component.thresholdCm).toBe(300); // recortado al máximo, igual que step()
      expect(component.hasPendingChanges).toBeTrue();
    });

    it('convierte de vuelta el valor escrito según `scale` antes de guardarlo', async () => {
      await component.promptEditValue('retardoEntradaDist', 'Retardo entrada', 'sg', 0.001);
      alertCtrl.pressConfirmButtonWithData({ value: '3.5' }); // 3.5 sg escritos

      expect(component.retardoEntradaDist).toBe(3500); // almacenado en ms
    });

    it('con entrada no numérica, deja el diálogo abierto (return false) y no toca el valor', async () => {
      component.thresholdCm = 80;
      await component.promptEditValue('thresholdCm', 'Umbral', 'cm');
      const result = alertCtrl.pressConfirmButtonWithData({ value: 'abc' });

      expect(result).toBeFalse();
      expect(component.thresholdCm).toBe(80);
      expect(component.hasPendingChanges).toBeFalse();
    });

    it('sobre depositoCap (puramente local) no marca ningún grupo como pendiente', async () => {
      await component.promptEditValue('depositoCap', 'Capacidad del depósito', 'L');
      alertCtrl.pressConfirmButtonWithData({ value: '3000' });

      expect(component.depositoCap).toBe(3000);
      expect(component.hasPendingChanges).toBeFalse();
    });
  });

  // ================================================================
  describe('guards de precondición antes de abrir el diálogo de calibración', () => {
    it('confirmLevelCalibration() sin conexión: toast de error, no abre el diálogo', async () => {
      bt.isConnected$.next(false);
      await component.confirmLevelCalibration();
      expect(alertCtrl.confirmDialogs.length).toBe(0);
      expect(alertCtrl.toasts[0].opts.message).toContain('Conecta primero');
    });

    it('confirmFullLevelCalibration() sin calibrar antes el vacío: toast de error, no abre el diálogo', async () => {
      bt.levelCalibrated$.next(false);
      await component.confirmFullLevelCalibration();
      expect(alertCtrl.confirmDialogs.length).toBe(0);
      expect(alertCtrl.toasts[0].opts.message).toContain('nivel vacío');
    });

    it('confirmTiltReferenceCalibration() sin calibrar antes el vacío: toast de error, no abre el diálogo', async () => {
      bt.levelCalibrated$.next(false);
      await component.confirmTiltReferenceCalibration();
      expect(alertCtrl.confirmDialogs.length).toBe(0);
    });

    it('confirmTiltApplyCalibration() sin capturar antes la referencia (paso 1): toast de error, no abre el diálogo', async () => {
      bt.tiltCalRefCaptured$.next(false);
      await component.confirmTiltApplyCalibration();
      expect(alertCtrl.confirmDialogs.length).toBe(0);
      expect(alertCtrl.toasts[0].opts.message).toContain('paso 1');
    });

    it('runTiltCalibrationStep() elige el paso 1 o el paso 2 según tiltCalRefCaptured$', async () => {
      spyOn(component, 'confirmTiltReferenceCalibration').and.resolveTo();
      spyOn(component, 'confirmTiltApplyCalibration').and.resolveTo();

      bt.tiltCalRefCaptured$.next(false);
      await component.runTiltCalibrationStep();
      expect(component.confirmTiltReferenceCalibration).toHaveBeenCalled();
      expect(component.confirmTiltApplyCalibration).not.toHaveBeenCalled();

      bt.tiltCalRefCaptured$.next(true);
      await component.runTiltCalibrationStep();
      expect(component.confirmTiltApplyCalibration).toHaveBeenCalled();
    });
  });

  // ================================================================
  describe('flujo completo del diálogo de confirmación (representativo: calibración de nivel vacío)', () => {
    it('al confirmar, llama a bt.calibrateLevel() y muestra un toast de éxito', async () => {
      await component.confirmLevelCalibration();
      expect(alertCtrl.confirmDialogs.length).toBe(1);

      await alertCtrl.pressConfirmButton('confirm');

      expect(bt.calibrateLevel).toHaveBeenCalled();
      expect(alertCtrl.toasts.length).toBe(1);
      expect(alertCtrl.toasts[0].opts.message).toContain('calibrado correctamente');
    });

    it('al cancelar, NO llama a bt.calibrateLevel()', async () => {
      await component.confirmLevelCalibration();
      await alertCtrl.pressConfirmButton('cancel');
      expect(bt.calibrateLevel).not.toHaveBeenCalled();
    });

    it('si calibrateLevel() falla, muestra el mensaje de error en el toast', async () => {
      bt.calibrateLevel.and.callFake(() => Promise.reject(new Error('sin ACK')));

      await component.confirmLevelCalibration();
      await alertCtrl.pressConfirmButton('confirm');

      expect(alertCtrl.toasts[0].opts.message).toBe('sin ACK');
    });

    it('calibrateTiltApply() con BAD_VALUE traduce el error a un mensaje accionable ("inclina más")', async () => {
      bt.tiltCalRefCaptured$.next(true);
      bt.calibrateTiltApply.and.callFake(() => Promise.reject(new Error('BAD_VALUE: inclinación insuficiente')));

      await component.confirmTiltApplyCalibration();
      await alertCtrl.pressConfirmButton('confirm');

      expect(alertCtrl.toasts[0].opts.message).toContain('inclina más');
    });
  });

  // ================================================================
  describe('startLeft()/startRight()/stopAll()', () => {
    it('startLeft()/startRight() fuera de modo temporizado: toast de error, no llaman a testTrigger()', async () => {
      bt.mode$.next(0);
      await component.startLeft();
      await component.startRight();
      expect(bt.testTrigger).not.toHaveBeenCalled();
    });

    it('startLeft()/startRight() en modo temporizado: llaman a testTrigger() con el lado correcto', async () => {
      bt.mode$.next(1);
      await component.startLeft();
      await component.startRight();
      expect(bt.testTrigger).toHaveBeenCalledWith('L');
      expect(bt.testTrigger).toHaveBeenCalledWith('R');
    });

    it('stopAll() llama a emergencyStop()', async () => {
      await component.stopAll();
      expect(bt.emergencyStop).toHaveBeenCalled();
    });

    it('si emergencyStop() falla, muestra un toast con el error', async () => {
      bt.emergencyStop.and.callFake(() => Promise.reject(new Error('sin ACK')));
      await component.stopAll();
      expect(alertCtrl.toasts[0].opts.message).toBe('sin ACK');
    });
  });

  // ================================================================
  describe('ionViewWillEnter()', () => {
    it('vuelca los valores actuales del servicio a los campos locales y redondea los límites de presión a 1 decimal', async () => {
      bt.sourceMode$.next(1);
      bt.thresholdCm$.next(77);
      bt.tankHeightMm$.next(500);
      bt.highPressureResetBar$.next(16.03);
      bt.highPressureAlarmBar$.next(18.07);

      await component.ionViewWillEnter();

      expect(component.sourceMode).toBe(1);
      expect(component.thresholdCm).toBe(77);
      expect(component.tankHeightMm).toBe(500);
      expect(component.pressureLowLimitBar).toBe(16.0);
      expect(component.pressureHighLimitBar).toBe(18.1);
    });

    it('carga depositoCap de Preferences si hay un valor guardado', async () => {
      localStorage.setItem(PREF_PREFIX + 'cfg.depositoCap', '4500');
      await component.ionViewWillEnter();
      expect(component.depositoCap).toBe(4500);
    });
  });
});
