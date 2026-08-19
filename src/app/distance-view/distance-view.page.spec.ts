import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { Router, provideRouter } from '@angular/router';
import { AlertController } from '@ionic/angular/standalone';
import { Preferences } from '@capacitor/preferences';

import { DistanceViewPage } from './distance-view.page';
import { BluetoothService } from '../services/bluetooth.service';

const PREF_PREFIX = 'CapacitorStorage.';

/** Doble de BluetoothService: solo la superficie que usa esta página. */
class FakeBluetoothService {
  isConnected$ = new BehaviorSubject<boolean>(false);
  mode$        = new BehaviorSubject<0 | 1>(0);
  sourceMode$  = new BehaviorSubject<0 | 1>(0);

  distanceLeft$  = new BehaviorSubject<number>(0);
  distanceRight$ = new BehaviorSubject<number>(0);
  relayLeft$     = new BehaviorSubject<boolean>(false);
  relayRight$    = new BehaviorSubject<boolean>(false);
  enabledLeft$   = new BehaviorSubject<boolean>(true);
  enabledRight$  = new BehaviorSubject<boolean>(true);

  relayLeftTimeMs$       = new BehaviorSubject<number>(0);
  relayLeftActivations$  = new BehaviorSubject<number>(0);
  relayRightTimeMs$      = new BehaviorSubject<number>(0);
  relayRightActivations$ = new BehaviorSubject<number>(0);

  levelPercent$     = new BehaviorSubject<number | null>(null);
  levelMm$          = new BehaviorSubject<number | null>(null);
  levelPressurePsi$ = new BehaviorSubject<number | null>(null);
  tiltDeg$          = new BehaviorSubject<number | null>(null);
  levelValid$       = new BehaviorSubject<boolean>(false);

  highPressureBar$          = new BehaviorSubject<number | null>(null);
  highPressureSensorFault$  = new BehaviorSubject<boolean>(false);
  highPressureLockout$      = new BehaviorSubject<boolean>(false);
  highPressureAlarmBar$     = new BehaviorSubject<number>(18.0);
  highPressureResetBar$     = new BehaviorSubject<number>(16.0);
  highPressureHardLimitBar$ = new BehaviorSubject<number>(19.5);

  requestStatus     = jasmine.createSpy('requestStatus').and.resolveTo(undefined);
  requestRelayStats = jasmine.createSpy('requestRelayStats').and.resolveTo(undefined);
  ping              = jasmine.createSpy('ping').and.resolveTo(undefined);
  resetRelayStats   = jasmine.createSpy('resetRelayStats').and.resolveTo(undefined);
  setSideEnabled    = jasmine.createSpy('setSideEnabled').and.resolveTo(undefined);
}

/** Mismo doble de AlertController que en las otras páginas. */
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
  get dialogs() { return this.created.filter(a => a.opts.header); }

  async pressButton(role: string): Promise<void> {
    const dialog = this.dialogs[this.dialogs.length - 1];
    const btn = dialog.opts.buttons.find((b: any) => typeof b === 'object' && b.role === role);
    btn?.handler?.();
    await new Promise(r => setTimeout(r, 0));
  }
}

/** Sustituye window.AudioContext por un doble inspeccionable, sin depender
 *  de que ChromeHeadless tenga (o no) un backend de audio real disponible. */
function installFakeAudioContext() {
  const createOscillatorSpy = jasmine.createSpy('createOscillator').and.callFake(() => ({
    type: '',
    frequency: { setValueAtTime: jasmine.createSpy(), linearRampToValueAtTime: jasmine.createSpy() },
    connect: jasmine.createSpy(),
    start: jasmine.createSpy(),
    stop: jasmine.createSpy(),
  }));
  const fakeCtx = {
    currentTime: 0,
    destination: {},
    state: 'running',
    createOscillator: createOscillatorSpy,
    createGain: jasmine.createSpy('createGain').and.callFake(() => ({
      gain: { setValueAtTime: jasmine.createSpy(), linearRampToValueAtTime: jasmine.createSpy() },
      connect: jasmine.createSpy(),
    })),
    resume: jasmine.createSpy('resume').and.resolveTo(undefined),
    close: jasmine.createSpy('close').and.resolveTo(undefined),
  };
  // new Fn() con una función que retorna explícitamente un objeto usa ESE
  // objeto como resultado en vez de `this` — truco estándar para simular una
  // clase construible con `new` sin tener que definir una clase real.
  (window as any).AudioContext = function () { return fakeCtx; };
  return { fakeCtx, createOscillatorSpy };
}

describe('DistanceViewPage', () => {
  let component: DistanceViewPage;
  let bt: FakeBluetoothService;
  let alertCtrl: FakeAlertController;
  let router: { navigate: jasmine.Spy };

  // Fix (misma causa que en bluetooth.service.spec.ts): @capacitor/
  // preferences carga su implementación web con un import() dinámico REAL
  // la primera vez que se usa, que fakeAsync()/tick() no puede forzar a
  // resolverse. ionViewWillEnter()/ngOnInit() de esta página llaman a
  // loadLocalConfig() (Preferences.get()) y varios tests lo hacen dentro de
  // fakeAsync() — precalentar aquí, fuera de cualquier fakeAsync, evita que
  // el PRIMERO de esos tests se quede con los spies en 0 llamadas.
  beforeAll(async () => {
    await Preferences.get({ key: '__warmup__' });
  });

  beforeEach(() => {
    localStorage.clear();
    bt = new FakeBluetoothService();
    alertCtrl = new FakeAlertController();

    TestBed.configureTestingModule({
      providers: [
        // Un objeto plano como Router (sin `events`) rompe el NavController
        // interno de Ionic (lo usa IonBackButton) con un "Cannot read
        // properties of undefined (reading 'subscribe')" — se necesita un
        // Router real y mínimo vía provideRouter(), espiando después solo
        // el método navigate().
        provideRouter([]),
        { provide: BluetoothService, useValue: bt },
        { provide: AlertController, useValue: alertCtrl },
      ],
    });
    router = { navigate: spyOn(TestBed.inject(Router), 'navigate') };
    component = TestBed.createComponent(DistanceViewPage).componentInstance;
  });

  afterEach(() => localStorage.clear());

  it('se crea y renderiza la plantilla sin errores', () => {
    const fixture = TestBed.createComponent(DistanceViewPage);
    expect(() => fixture.detectChanges()).not.toThrow();
  });

  // ================================================================
  describe('observables derivados', () => {
    it('depositoRestante$/depositoConsumido$/depositoLow$ derivan de levelPercent$ y la capacidad', () => {
      (component as any).depositoCap$.next(1000);

      // `let x: T | null = null` capturada en un subscribe() hace que TS la
      // siga viendo como literal `null` fuera del closure (no rewidenea a
      // `number | null`) — se usa el mismo patrón de aserción de asignación
      // definida (`!`) que en ble-transport.service.ts para evitarlo.
      let restante!: number | null;
      component.depositoRestante$.subscribe(v => restante = v);
      let consumido!: number | null;
      component.depositoConsumido$.subscribe(v => consumido = v);
      let low = false;
      component.depositoLow$.subscribe(v => low = v);

      bt.levelPercent$.next(30);
      expect(restante).toBe(300);
      expect(consumido).toBe(700);
      expect(low).toBeFalse();

      bt.levelPercent$.next(5);
      expect(low).toBeTrue();

      bt.levelPercent$.next(null);
      expect(restante).toBeNull();
      expect(consumido).toBeNull();
    });

    it('depositoRestante$ recorta el porcentaje a [0,100] aunque llegue fuera de rango', () => {
      (component as any).depositoCap$.next(1000);
      let restante!: number | null;
      component.depositoRestante$.subscribe(v => restante = v);

      bt.levelPercent$.next(150);
      expect(restante).toBe(1000);
      bt.levelPercent$.next(-10);
      expect(restante).toBe(0);
    });

    it('highPressureState$: sensor-fault tiene prioridad sobre lockout, y lockout sobre el valor de bar', () => {
      let state = '';
      component.highPressureState$.subscribe(v => state = v);
      expect(state).toBe('unknown');

      bt.highPressureBar$.next(15);
      expect(state).toBe('ok');

      bt.highPressureLockout$.next(true);
      expect(state).toBe('lockout');

      bt.highPressureSensorFault$.next(true);
      expect(state).toBe('sensor-fault'); // manda incluso con lockout también activo
    });

    it('pressureGaugeColor$: verde en el tramo seguro 10-30, rojo fuera de él, y fallo/bloqueo mandan sobre el valor', () => {
      let color = '';
      component.pressureGaugeColor$.subscribe(v => color = v);

      bt.highPressureBar$.next(20);
      expect(color).toBe('#4bd85b');

      bt.highPressureBar$.next(5);
      expect(color).toBe('#ff4f4f');

      bt.highPressureLockout$.next(true);
      expect(color).toBe('#e74c3c');

      bt.highPressureLockout$.next(false);
      bt.highPressureSensorFault$.next(true);
      expect(color).toBe('#8e1b1b');
    });

    it('pressureGaugeDash$ escala bar a la longitud del arco, recortando a [0,40]', () => {
      let dash = '';
      component.pressureGaugeDash$.subscribe(v => dash = v);

      bt.highPressureBar$.next(20); // mitad de escala
      expect(dash).toBe('85 141');

      bt.highPressureBar$.next(100); // fuera de escala, recorta a 40
      expect(dash).toBe('170 56');
    });
  });

  // ================================================================
  describe('capacidad del depósito desde Preferences', () => {
    it('usa el valor guardado si es un número válido y positivo', async () => {
      localStorage.setItem(PREF_PREFIX + 'cfg.depositoCap', '3500');
      await component.ionViewWillEnter();

      let restante!: number | null;
      component.depositoRestante$.subscribe(v => restante = v);
      bt.levelPercent$.next(50);
      expect(restante).toBe(1750); // 50% de 3500
    });

    it('usa el valor por defecto (2000) si lo guardado no es un número válido', async () => {
      localStorage.setItem(PREF_PREFIX + 'cfg.depositoCap', 'no-es-un-numero');
      await component.ionViewWillEnter();

      let restante!: number | null;
      component.depositoRestante$.subscribe(v => restante = v);
      bt.levelPercent$.next(50);
      expect(restante).toBe(1000); // 50% de 2000
    });
  });

  // ================================================================
  describe('helpers puros', () => {
    it('formatMsToMinSec()', () => {
      expect(component.formatMsToMinSec(0)).toBe('00:00');
      expect(component.formatMsToMinSec(65000)).toBe('01:05');
      expect(component.formatMsToMinSec(null)).toBe('00:00');
      expect(component.formatMsToMinSec(-500)).toBe('00:00'); // nunca negativo
    });

    it('highPressureStateText()', () => {
      expect(component.highPressureStateText('sensor-fault')).toContain('sensor');
      expect(component.highPressureStateText('lockout')).toContain('Bloqueo');
      expect(component.highPressureStateText('ok')).toContain('normal');
      expect(component.highPressureStateText('unknown')).toContain('Sin lectura');
    });

    it('sourceModeText()', () => {
      expect(component.sourceModeText(1)).toBe('Entradas PC817');
      expect(component.sourceModeText(0)).toBe('Ultrasonidos');
      expect(component.sourceModeText(null)).toBe('Ultrasonidos');
    });

    it('sideValueText(): con entradas PC817 muestra ACTIVO/INACTIVO en vez de la distancia', () => {
      expect(component.sideValueText(1, 50, true)).toBe('ACTIVO');
      expect(component.sideValueText(1, 50, false)).toBe('INACTIVO');
      expect(component.sideValueText(0, 50, true)).toBe('50 cm');
      expect(component.sideValueText(0, null, true)).toBe('--');
    });

    it('levelColor(): gris si no es válido, y rojo/naranja/azul según el porcentaje', () => {
      expect(component.levelColor(50, false)).toBe('#95a5a6');
      expect(component.levelColor(null, true)).toBe('#95a5a6');
      expect(component.levelColor(5, true)).toBe('#e74c3c');
      expect(component.levelColor(20, true)).toBe('#f39c12');
      expect(component.levelColor(80, true)).toBe('#0984e3');
    });

    it('levelGaugeDash() escala el porcentaje al arco, recortando a [0,100]', () => {
      expect(component.levelGaugeDash(0)).toBe('0 364');
      expect(component.levelGaugeDash(50)).toBe('137 227');
      expect(component.levelGaugeDash(150)).toBe('273 91');
    });
  });

  // ================================================================
  describe('onToggleLeft() / onToggleRight()', () => {
    it('éxito al desactivar: llama a setSideEnabled y fuerza relayLeft$ a false', async () => {
      await component.onToggleLeft({ detail: { checked: false } });
      expect(bt.setSideEnabled).toHaveBeenCalledWith('L', false);
      expect(bt.relayLeft$.value).toBeFalse();
    });

    it('éxito al activar: no toca relayLeft$', async () => {
      bt.relayLeft$.next(true);
      await component.onToggleLeft({ detail: { checked: true } });
      expect(bt.relayLeft$.value).toBeTrue();
    });

    it('fallo: revierte enabledLeft$ y fuerza el DOM del elemento tocado (ion-toggle no se re-sincroniza solo)', async () => {
      bt.setSideEnabled.and.callFake(() => Promise.reject(new Error('sin ACK')));
      const fakeTarget = { checked: true };

      await component.onToggleLeft({ detail: { checked: true }, target: fakeTarget });

      expect(bt.enabledLeft$.value).toBeFalse();
      expect(fakeTarget.checked).toBeFalse();
    });

    it('reentrancia: una segunda llamada mientras la primera sigue en curso se ignora', async () => {
      let resolve!: () => void;
      bt.setSideEnabled.and.callFake(() => new Promise<void>(res => { resolve = res; }));

      const p1 = component.onToggleLeft({ detail: { checked: true } });
      const p2 = component.onToggleLeft({ detail: { checked: false } });
      resolve();
      await p1; await p2;

      expect(bt.setSideEnabled).toHaveBeenCalledTimes(1);
    });

    it('onToggleRight() replica el mismo comportamiento con el lado derecho', async () => {
      await component.onToggleRight({ detail: { checked: false } });
      expect(bt.setSideEnabled).toHaveBeenCalledWith('R', false);
      expect(bt.relayRight$.value).toBeFalse();
    });
  });

  // ================================================================
  describe('confirmResetStats()', () => {
    it('sin conexión, no abre el diálogo', async () => {
      bt.isConnected$.next(false);
      await component.confirmResetStats('L');
      expect(alertCtrl.dialogs.length).toBe(0);
    });

    it('al confirmar, llama a resetRelayStats(side)', async () => {
      bt.isConnected$.next(true);
      await component.confirmResetStats('R');
      await alertCtrl.pressButton('confirm');
      expect(bt.resetRelayStats).toHaveBeenCalledWith('R');
    });

    it('al cancelar, no llama a resetRelayStats()', async () => {
      bt.isConnected$.next(true);
      await component.confirmResetStats('L');
      await alertCtrl.pressButton('cancel');
      expect(bt.resetRelayStats).not.toHaveBeenCalled();
    });

    it('reentrancia por lado: una segunda confirmación del mismo lado mientras la primera sigue en curso se ignora', async () => {
      bt.isConnected$.next(true);
      let resolve!: () => void;
      bt.resetRelayStats.and.callFake(() => new Promise<void>(res => { resolve = res; }));

      await component.confirmResetStats('L');
      await alertCtrl.pressButton('confirm'); // runResetStats('L') queda "colgado", resettingStatsLeft=true
      await component.confirmResetStats('L');
      await alertCtrl.pressButton('confirm'); // debe ser ignorada por el guard

      resolve();
      expect(bt.resetRelayStats).toHaveBeenCalledTimes(1);
    });
  });

  // ================================================================
  describe('navegación', () => {
    it('goToBluetoothSettings() navega a /bt-settings', () => {
      component.goToBluetoothSettings();
      expect(router.navigate).toHaveBeenCalledWith(['/bt-settings']);
    });

    it('openConfigPage() navega a /auto-config', () => {
      component.openConfigPage();
      expect(router.navigate).toHaveBeenCalledWith(['/auto-config']);
    });
  });

  // ================================================================
  describe('confirmExitApp()', () => {
    // No se pulsa el botón "Salir": su handler llama a App.exitApp() de
    // @capacitor/app, que es un Proxy de registerPlugin() (mismo caso que
    // Preferences, ver bluetooth.service.spec.ts) — no se puede espiar, y en
    // web lanza "Not implemented" dentro de una promesa que el propio código
    // no espera ni captura (fire-and-forget), así que pulsarlo de verdad en
    // un test dejaría una rejection sin manejar. Se prueba solo el diálogo.
    it('avisa explícitamente de que el equipo puede seguir pulverizando si sigue conectado', async () => {
      bt.isConnected$.next(true);
      await component.confirmExitApp();
      expect(alertCtrl.dialogs.length).toBe(1);
      expect(alertCtrl.dialogs[0].opts.message).toContain('sigue conectado');
      expect(alertCtrl.dialogs[0].opts.message).toContain('puede seguir pulverizando');
    });

    it('mensaje más simple si no hay conexión activa', async () => {
      bt.isConnected$.next(false);
      await component.confirmExitApp();
      expect(alertCtrl.dialogs[0].opts.message).not.toContain('pulverizando');
    });

    it('pide confirmación (no cierra directamente) — tiene botón Cancelar además de Salir', async () => {
      await component.confirmExitApp();
      const roles = alertCtrl.dialogs[0].opts.buttons.map((b: any) => b.role);
      expect(roles).toContain('cancel');
      expect(roles).toContain('destructive');
    });
  });

  // ================================================================
  describe('ionViewWillEnter() / ionViewWillLeave()', () => {
    it('conectado: pide status/relayStats/ping y arranca el sondeo periódico cada 2s', fakeAsync(() => {
      bt.isConnected$.next(true);
      component.ionViewWillEnter();
      tick(500); // margen generoso para Preferences.get() real (import() dinámico de Capacitor, ver nota en bluetooth.service.spec.ts)

      expect(bt.requestStatus).toHaveBeenCalledTimes(1);
      expect(bt.requestRelayStats).toHaveBeenCalledTimes(1);
      expect(bt.ping).toHaveBeenCalledTimes(1);

      tick(2000);
      expect(bt.requestStatus).toHaveBeenCalledTimes(2);

      component.ionViewWillLeave();
      discardPeriodicTasks();
    }));

    it('desconectado: no pide nada ni arranca el sondeo', fakeAsync(() => {
      bt.isConnected$.next(false);
      component.ionViewWillEnter();
      tick(2050);

      expect(bt.requestStatus).not.toHaveBeenCalled();
      discardPeriodicTasks();
    }));

    it('ionViewWillLeave() detiene el sondeo periódico', fakeAsync(() => {
      bt.isConnected$.next(true);
      component.ionViewWillEnter();
      tick(500); // margen generoso para Preferences.get() real (import() dinámico de Capacitor, ver nota en bluetooth.service.spec.ts)
      component.ionViewWillLeave();

      bt.requestStatus.calls.reset();
      tick(4000);
      expect(bt.requestStatus).not.toHaveBeenCalled();
    }));
  });

  // ================================================================
  describe('alarma sonora de alta presión', () => {
    let audio: ReturnType<typeof installFakeAudioContext>;

    beforeEach(() => { audio = installFakeAudioContext(); });

    it('arranca al entrar en lockout/sensor-fault y se repite cada 1200ms', fakeAsync(() => {
      component.ngOnInit();
      tick(500); // margen generoso para Preferences.get() real (import() dinámico de Capacitor, ver nota en bluetooth.service.spec.ts)

      bt.highPressureLockout$.next(true);
      tick(0);
      expect(audio.createOscillatorSpy).toHaveBeenCalledTimes(1); // pitido inmediato

      tick(1200);
      expect(audio.createOscillatorSpy).toHaveBeenCalledTimes(2);

      component.ionViewWillLeave();
      discardPeriodicTasks();
    }));

    it('al volver a "ok" detiene la alarma', fakeAsync(() => {
      component.ngOnInit();
      tick(500); // margen generoso para Preferences.get() real (import() dinámico de Capacitor, ver nota en bluetooth.service.spec.ts)
      bt.highPressureLockout$.next(true);
      tick(0);
      bt.highPressureLockout$.next(false);
      tick(0);

      const callsAtRecovery = audio.createOscillatorSpy.calls.count();
      tick(3000);
      expect(audio.createOscillatorSpy.calls.count()).toBe(callsAtRecovery);

      discardPeriodicTasks();
    }));

    it('toggleMute() silencia una alarma activa sin más pitidos', fakeAsync(() => {
      component.ngOnInit();
      tick(500); // margen generoso para Preferences.get() real (import() dinámico de Capacitor, ver nota en bluetooth.service.spec.ts)
      bt.highPressureLockout$.next(true);
      tick(0);

      component.toggleMute();
      const callsAtMute = audio.createOscillatorSpy.calls.count();
      tick(3000);
      expect(audio.createOscillatorSpy.calls.count()).toBe(callsAtMute);

      discardPeriodicTasks();
    }));
  });

  it('ngOnDestroy() no lanza aunque nunca se haya llamado a ngOnInit() (limpieza defensiva)', () => {
    expect(() => component.ngOnDestroy()).not.toThrow();
  });
});
