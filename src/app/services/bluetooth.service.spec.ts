import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { Preferences } from '@capacitor/preferences';

import { BluetoothService } from './bluetooth.service';
import {
  BleTransportService,
  BluetoothDevice,
  LogEntry,
  RawFrame,
  EVT_DIST,
  EVT_RELAY,
  EVT_SNAPSHOT,
  EVT_STATUS,
  EVT_RELAYSTAT,
  EVT_LEVEL,
  EVT_HIGH_PRESSURE,
} from './ble-transport.service';

// CMD_* de DOMINIO: son privados en BluetoothService (ver bluetooth.service.ts,
// sección "PROTOCOLO"), así que se duplican aquí solo como literales para
// poder identificar en los asserts qué comando mandó sendCmd(). Si algún día
// cambian esos opcodes en la fuente, hay que actualizarlos también aquí.
const CMD_SET_CONFIG                     = 0x02;
const CMD_GET_STATUS                     = 0x03;
const CMD_SET_ENABLE                     = 0x05;
const CMD_CALIBRATE_LEVEL                = 0x09;
const CMD_SET_HIGH_PRESSURE_CONFIG       = 0x0A;
const CMD_CALIBRATE_LEVEL_FULL           = 0x0B;
const CMD_SET_TANK_GEOMETRY              = 0x0C;
const CMD_CALIBRATE_TILT_REF             = 0x0D;
const CMD_CALIBRATE_TILT_APPLY           = 0x0E;
const CMD_CALIBRATE_HIGH_PRESSURE_ZERO   = 0x0F;
const CMD_CALIBRATE_HIGH_PRESSURE_REF    = 0x19;

function u16LE(v: number): [number, number] { return [v & 0xFF, (v >> 8) & 0xFF]; }
function u32LE(v: number): [number, number, number, number] {
  return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF];
}

const TEST_DEVICE: BluetoothDevice = { name: 'TEST', address: '00:00:00:00:00:01' };

// BluetoothService persiste vía @capacitor/preferences, que en web es un
// wrapper fino sobre localStorage bajo la clave "CapacitorStorage.<key>"
// (ver PreferencesWeb en node_modules/@capacitor/preferences). No se puede
// espiar con spyOn(): registerPlugin() de Capacitor devuelve un Proxy cuyo
// get() SIEMPRE fabrica un wrapper nuevo para cualquier propiedad pedida,
// ignorando cualquier valor que spyOn() le asigne encima — así que
// spyOn(Preferences, 'set') "funciona" sin lanzar error pero no intercepta
// nada en absoluto, y las llamadas reales de todos modos caen sobre
// localStorage real, compartido entre tests. Se aísla limpiando localStorage
// de verdad antes de cada test en vez de intentar espiar el Proxy.
const PREF_PREFIX = 'CapacitorStorage.';

/**
 * Doble de BleTransportService: expone los mismos Subjects/BehaviorSubjects
 * públicos que el real (misma identidad de objeto — la fachada los reexpone
 * tal cual), pero connect()/disconnect()/sendCmd()/etc. son spies
 * controlables por cada test. El framing binario real (CRC, cola, ACKs) ya
 * está cubierto en ble-transport.service.spec.ts; aquí solo interesa la
 * lógica de DOMINIO de BluetoothService, aislada de esa capa.
 */
class FakeTransport {
  isConnected$           = new BehaviorSubject<boolean>(false);
  connectedDevice$       = new BehaviorSubject<BluetoothDevice | null>(null);
  pairedDevices$         = new BehaviorSubject<BluetoothDevice[]>([]);
  unpairedDevices$       = new BehaviorSubject<BluetoothDevice[]>([]);
  logEntries$            = new BehaviorSubject<LogEntry[]>([]);
  arduinoProtocolVersion$ = new BehaviorSubject<number>(0);
  frame$                 = new Subject<RawFrame>();
  reconnectRequested$    = new Subject<void>();
  pauseHeartbeat = false;
  logEnabled = false;

  sendCmd = jasmine.createSpy('sendCmd').and.resolveTo(undefined);
  connect = jasmine.createSpy('connect').and.callFake(async (dev: BluetoothDevice | string) => {
    const device = typeof dev === 'string' ? { name: dev, address: dev } : dev;
    this.connectedDevice$.next(device);
    this.isConnected$.next(true);
  });
  disconnect = jasmine.createSpy('disconnect').and.callFake(async () => {
    this.isConnected$.next(false);
    this.connectedDevice$.next(null);
  });
  adaptToProtocolVersion = jasmine.createSpy('adaptToProtocolVersion');
  log      = jasmine.createSpy('log');
  clearLog = jasmine.createSpy('clearLog');
  listPairedDevices = jasmine.createSpy('listPairedDevices').and.resolveTo([]);
  loadPairedDevices = jasmine.createSpy('loadPairedDevices').and.resolveTo(undefined);
  unpairDevice      = jasmine.createSpy('unpairDevice').and.resolveTo(undefined);
  unpairAllPaired   = jasmine.createSpy('unpairAllPaired').and.resolveTo({ removed: 0, failed: [] });
  scanForUnpaired   = jasmine.createSpy('scanForUnpaired').and.resolveTo(undefined);
}

describe('BluetoothService (fachada de dominio)', () => {
  let service: BluetoothService;
  let transport: FakeTransport;

  // Fix (encontrado con una CI flaky, no reproducible siempre en local):
  // @capacitor/preferences (Preferences) carga su implementación web con un
  // import() dinámico REAL la primera vez que se usa — un import de módulo
  // de verdad, no un microtask — que fakeAsync()/tick() NO puede forzar a
  // resolverse por mucho margen virtual que se le dé, porque vive fuera del
  // reloj falso. Si esa PRIMERA llamada a Preferences.get()/.set() de toda
  // la suite ocurre dentro de un fakeAsync() (p.ej. durante connect(), que
  // llama a saveConfigToPreferences()), el tick() se queda esperando un
  // import que nunca "avanza" con el reloj falso, y las aserciones fallan
  // con recuentos en 0 — exactamente el fallo visto en CI. Precalentar aquí
  // (fuera de cualquier fakeAsync, con un await real) hace que el import ya
  // esté cacheado por el navegador para el resto de la suite: a partir de
  // ahí, cada Preferences.get()/.set() posterior sí es solo una promesa
  // normal que tick() puede flushear sin problema.
  beforeAll(async () => {
    await Preferences.get({ key: '__warmup__' });
  });

  beforeEach(() => {
    // Limpio ANTES de instanciar el servicio: su constructor dispara un
    // loadConfigFromPreferences() en segundo plano (sin esperarlo) que, con
    // localStorage sucio de un test anterior, podría pisar en cualquier
    // momento posterior los valores que el propio test bajo prueba acaba de
    // fijar — con localStorage vacío, todas las Preferences.get() devuelven
    // null y esa carga inicial no toca ningún BehaviorSubject (ver los guards
    // `if (x.value !== null)` en loadConfigFromPreferences()).
    localStorage.clear();

    transport = new FakeTransport();
    TestBed.configureTestingModule({
      providers: [{ provide: BleTransportService, useValue: transport }],
    });
    service = TestBed.inject(BluetoothService);
  });

  afterEach(() => localStorage.clear());

  function pushFrame(type: number, payload: number[]) {
    transport.frame$.next({ type, seq: 0, payload: new Uint8Array(payload) });
  }

  // ================================================================
  describe('decodificación de tramas de dominio (dispatchDomainFrame)', () => {
    it('EVT_DIST actualiza distanceLeft$/distanceRight$ según el lado', () => {
      pushFrame(EVT_DIST, ['L'.charCodeAt(0), ...u16LE(123)]);
      expect(service.distanceLeft$.value).toBe(123);
      pushFrame(EVT_DIST, ['R'.charCodeAt(0), ...u16LE(45)]);
      expect(service.distanceRight$.value).toBe(45);
    });

    it('EVT_RELAY actualiza relayLeft$/relayRight$ según el lado', () => {
      pushFrame(EVT_RELAY, ['L'.charCodeAt(0), 1, 0]);
      expect(service.relayLeft$.value).toBeTrue();
      pushFrame(EVT_RELAY, ['R'.charCodeAt(0), 0, 1]);
      expect(service.relayRight$.value).toBeFalse();
    });

    it('EVT_LEVEL decodifica presión/nivel/porcentaje/inclinación/validez', () => {
      pushFrame(EVT_LEVEL, [...u16LE(1234), ...u16LE(567), ...u16LE(890), 12, 1]);
      expect(service.levelPressurePsi$.value).toBeCloseTo(12.34, 5);
      expect(service.levelMm$.value).toBe(567);
      expect(service.levelPercent$.value).toBeCloseTo(89.0, 5);
      expect(service.tiltDeg$.value).toBe(12);
      expect(service.levelValid$.value).toBeTrue();
    });

    it('EVT_HIGH_PRESSURE decodifica bar/fault/lockout y, si viene, los bits de calibración', () => {
      pushFrame(EVT_HIGH_PRESSURE, [...u16LE(1850), 0, 1, 0b11]);
      expect(service.highPressureBar$.value).toBeCloseTo(18.5, 5);
      expect(service.highPressureSensorFault$.value).toBeFalse();
      expect(service.highPressureLockout$.value).toBeTrue();
      expect(service.highPressureZeroCalibrated$.value).toBeTrue();
      expect(service.highPressureRefCalibrated$.value).toBeTrue();
    });

    it('EVT_HIGH_PRESSURE sin el byte de calibración (firmware <v14) no toca los flags de calibración', () => {
      service.highPressureZeroCalibrated$.next(true); // valor previo, no debe cambiar
      pushFrame(EVT_HIGH_PRESSURE, [...u16LE(1000), 0, 0]); // solo 4 bytes, sin calibBits
      expect(service.highPressureBar$.value).toBeCloseTo(10.0, 5);
      expect(service.highPressureZeroCalibrated$.value).toBeTrue();
    });

    it('EVT_RELAYSTAT decodifica tiempos/activaciones de ambos lados', () => {
      pushFrame(EVT_RELAYSTAT, [...u32LE(1000), ...u32LE(3), ...u32LE(2000), ...u32LE(7)]);
      expect(service.relayLeftTimeMs$.value).toBe(1000);
      expect(service.relayLeftActivations$.value).toBe(3);
      expect(service.relayRightTimeMs$.value).toBe(2000);
      expect(service.relayRightActivations$.value).toBe(7);
      expect(service.relayStats$.value).toEqual({
        L: { timeMs: 1000, activations: 3 },
        R: { timeMs: 2000, activations: 7 },
      });
    });

    it('EVT_SNAPSHOT decodifica el bloque base + la extensión de nivel (bytes 20-26)', () => {
      const base = [
        1, 0,           // Lr, Rr
        1, 0,           // enL, enR
        0, 1,           // srcMode, m
        ...u16LE(60),   // thresholdCm
        ...u16LE(15),   // hysteresisCm
        ...u16LE(100),  // retardoEntradaDist
        ...u16LE(200),  // retardoSalidaDist
        ...u16LE(300),  // retardoEntradaTemp
        ...u32LE(4000), // activeTimeModo1
      ];
      const levelExt = [...u16LE(150), ...u16LE(1234), 5, 1, 0b01]; // levelMm, presión, tilt, valid, calibBits
      pushFrame(EVT_SNAPSHOT, [...base, ...levelExt]);

      expect(service.relayLeft$.value).toBeTrue();
      expect(service.relayRight$.value).toBeFalse();
      expect(service.enabledLeft$.value).toBeTrue();
      expect(service.enabledRight$.value).toBeFalse();
      expect(service.sourceMode$.value).toBe(0);
      expect(service.mode$.value).toBe(1);
      expect(service.thresholdCm$.value).toBe(60);
      expect(service.hysteresisCm$.value).toBe(15);
      expect(service.activeTimeModo1$.value).toBe(4000);
      // extensión de nivel (bits de calibración: bit0=1 -> vacío calibrado)
      expect(service.levelMm$.value).toBe(150);
      expect(service.levelCalibrated$.value).toBeTrue();
      expect(service.levelFullCalibrated$.value).toBeFalse();
    });

    it('EVT_STATUS decodifica el bloque base + la extensión de nivel (bytes 24-30)', () => {
      const base = [
        ...u16LE(77), ...u16LE(88), // dL, dR
        1, 1,                       // RL, RR
        1, 1,                       // enL, enR
        1, 0,                       // srcMode, m
        ...u16LE(50), ...u16LE(10),
        ...u16LE(0), ...u16LE(0),
        ...u16LE(0),
        ...u32LE(2000),
      ];
      const levelExt = [...u16LE(99), ...u16LE(500), 3, 1, 0b10]; // bit1=1 -> lleno calibrado
      pushFrame(EVT_STATUS, [...base, ...levelExt]);

      expect(service.distanceLeft$.value).toBe(77);
      expect(service.distanceRight$.value).toBe(88);
      expect(service.relayLeft$.value).toBeTrue();
      expect(service.relayRight$.value).toBeTrue();
      expect(service.levelMm$.value).toBe(99);
      expect(service.levelCalibrated$.value).toBeFalse();
      expect(service.levelFullCalibrated$.value).toBeTrue();
    });
  });

  // ================================================================
  describe('connect() — sincronización de dominio', () => {
    /** Payload EVT_STATUS de 24 bytes exactos (sin extensión de nivel). */
    function statusPayload(enL: boolean, enR: boolean): number[] {
      return [
        ...u16LE(0), ...u16LE(0),
        0, 0,
        enL ? 1 : 0, enR ? 1 : 0,
        0, 0,
        ...u16LE(50), ...u16LE(10),
        ...u16LE(0), ...u16LE(0),
        ...u16LE(0),
        ...u32LE(0),
      ];
    }

    it('si requestStatus() confirma un estado real distinto de la intención local, reenvía SET_ENABLE con la intención local (no el valor del Arduino)', fakeAsync(() => {
      service.enabledLeft$.next(false); // el usuario lo apagó estando desconectado

      transport.sendCmd.and.callFake((cmdType: number) => {
        if (cmdType === CMD_GET_STATUS) pushFrame(EVT_STATUS, statusPayload(true, true)); // el Arduino sigue con L=true
        return Promise.resolve();
      });

      service.connect(TEST_DEVICE);
      // connect() espera 200ms tras requestStatus()/requestRelayStats(), pero
      // el margen real necesario depende también de saveConfigToPreferences()
      // al final (Preferences.set() de Capacitor hace un import() dinámico
      // real, no un simple microtask — fakeAsync no lo controla, así que su
      // duración de verdad varía con la carga de la máquina). 300ms bastaba
      // en local pero flaqueó en el runner de CI bajo carga: se sube el
      // margen bastante por encima de lo estrictamente necesario.
      tick(2000);

      const setEnableCalls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_SET_ENABLE);
      expect(setEnableCalls.length).toBe(1);
      const payload = setEnableCalls[0][1] as Uint8Array;
      expect(String.fromCharCode(payload[0])).toBe('L');
      expect(payload[1]).toBe(0); // intención local (apagado), no el true que reportó el Arduino
    }));

    it('si requestStatus() falla, no fuerza ningún SET_ENABLE a ciegas (regresión: antes podía empujar el caché local, potencialmente corrupto)', fakeAsync(() => {
      service.enabledLeft$.next(false);
      transport.sendCmd.and.callFake((cmdType: number) => {
        if (cmdType === CMD_GET_STATUS) return Promise.reject('sin respuesta');
        return Promise.resolve();
      });

      service.connect(TEST_DEVICE);
      tick(2000); // mismo margen generoso que arriba, ver nota junto al primer tick(2000)

      const setEnableCalls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_SET_ENABLE);
      expect(setEnableCalls.length).toBe(0);
    }));

    it('llama a transport.adaptToProtocolVersion() al terminar la sincronización', fakeAsync(() => {
      service.connect(TEST_DEVICE);
      tick(2000);
      expect(transport.adaptToProtocolVersion).toHaveBeenCalled();
    }));
  });

  // ================================================================
  describe('flushConfig() / applyConfigOnce()', () => {
    const validCfg = {
      sourceMode: 0 as const, mode: 0 as const,
      thresholdCm: 60, hysteresisCm: 10,
      retardoEntradaDist: 0, retardoSalidaDist: 0,
      retardoEntradaTemp: 0, activeTimeModo1: 1000,
    };

    it('si validateConfig() lanza, cfgInFlight no se queda atascado en true (regresión: antes bloqueaba en silencio todo "Aplicar" futuro)', async () => {
      transport.isConnected$.next(true);

      let error: any;
      try {
        await service.applyConfigOnce({ ...validCfg, thresholdCm: 999999 }); // fuera de rango -> BAD_VALUE
      } catch (e) { error = e; }
      expect(error).toBeDefined();

      // Si cfgInFlight se hubiera quedado atascado en true, este segundo
      // intento (con valores válidos) se descartaría en silencio por el
      // guard de flushConfig() y sendCmd(CMD_SET_CONFIG) no se llamaría.
      transport.sendCmd.calls.reset();
      await service.applyConfigOnce(validCfg);
      const setConfigCalls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_SET_CONFIG);
      expect(setConfigCalls.length).toBe(1);
    });

    it('si CMD_SET_CONFIG falla, applyConfigOnce() propaga el error y revierte los BehaviorSubjects al valor previo (regresión: antes el fallo se tragaba en flushConfig())', async () => {
      transport.isConnected$.next(true);
      service.thresholdCm$.next(50);

      transport.sendCmd.and.callFake((cmdType: number) =>
        cmdType === CMD_SET_CONFIG ? Promise.reject('sin ACK') : Promise.resolve()
      );

      let error: any;
      try { await service.applyConfigOnce({ ...validCfg, thresholdCm: 120 }); }
      catch (e) { error = e; }

      expect(error).toBeDefined();
      expect(service.thresholdCm$.value).toBe(50); // revertido, no se queda en 120
    });

    it('mientras hay un envío de config en curso, pausa el heartbeat del transporte y lo reactiva al terminar', async () => {
      transport.isConnected$.next(true);
      let pausedDuringSend = false;
      transport.sendCmd.and.callFake((cmdType: number) => {
        if (cmdType === CMD_SET_CONFIG) pausedDuringSend = transport.pauseHeartbeat;
        return Promise.resolve();
      });

      await service.applyConfigOnce(validCfg);

      expect(pausedDuringSend).toBeTrue();
      expect(transport.pauseHeartbeat).toBeFalse();
    });
  });

  // ================================================================
  describe('setSideEnabled()', () => {
    it('sin conexión: guarda la intención localmente sin mandar ningún comando', async () => {
      transport.isConnected$.next(false);
      await service.setSideEnabled('L', false);
      expect(service.enabledLeft$.value).toBeFalse();
      expect(transport.sendCmd).not.toHaveBeenCalled();
      // persistido para aplicarlo al conectar
      expect(localStorage.getItem(PREF_PREFIX + 'app.enableLeft')).toBe('0');
    });

    it('conectado y ACK OK: manda CMD_SET_ENABLE y persiste solo tras la confirmación', async () => {
      transport.isConnected$.next(true);

      await service.setSideEnabled('R', true);

      const calls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_SET_ENABLE);
      expect(calls.length).toBe(1);
      const payload = calls[0][1] as Uint8Array;
      expect(String.fromCharCode(payload[0])).toBe('R');
      expect(payload[1]).toBe(1);
      expect(localStorage.getItem(PREF_PREFIX + 'app.enableRight')).toBe('1');
    });

    it('conectado y sin ACK: lanza el error (para que el llamador revierta el toggle optimista) y no persiste el valor no confirmado', async () => {
      transport.isConnected$.next(true);
      transport.sendCmd.and.callFake(() => Promise.reject('sin ACK'));

      let error: any;
      try { await service.setSideEnabled('L', false); } catch (e) { error = e; }

      expect(error).toBeDefined();
      // localStorage limpio en beforeEach y este intento fallido nunca debe
      // haber llegado a llamar a saveConfigToPreferences().
      expect(localStorage.getItem(PREF_PREFIX + 'app.enableLeft')).toBeNull();
    });
  });

  // ================================================================
  describe('reconexión (disparada por transport.reconnectRequested$)', () => {
    it('desconecta y vuelve a conectar el mismo dispositivo que estaba activo', fakeAsync(() => {
      transport.connectedDevice$.next(TEST_DEVICE);
      transport.isConnected$.next(true);

      transport.reconnectRequested$.next();
      // 800ms de espera interna de reconnect() + connect() completo (que a su
      // vez incluye saveConfigToPreferences() al final — ver nota extensa
      // junto al primer tick(2000) del describe de connect() más arriba
      // sobre por qué necesita bastante más margen del estrictamente
      // calculable en un runner de CI cargado).
      tick(3000);

      expect(transport.disconnect).toHaveBeenCalledTimes(1);
      expect(transport.connect).toHaveBeenCalledTimes(1);
      expect(transport.connect.calls.mostRecent().args[0]).toEqual(TEST_DEVICE);
    }));

    it('si no hay ningún dispositivo conectado, no intenta reconectar', fakeAsync(() => {
      transport.connectedDevice$.next(null);
      transport.reconnectRequested$.next();
      tick(1200);

      expect(transport.disconnect).not.toHaveBeenCalled();
      expect(transport.connect).not.toHaveBeenCalled();
    }));

    it('una segunda señal mientras ya se está reconectando se ignora (reentrancia)', fakeAsync(() => {
      transport.connectedDevice$.next(TEST_DEVICE);
      transport.isConnected$.next(true);

      transport.reconnectRequested$.next();
      tick(10); // sigue en curso el primer intento
      transport.reconnectRequested$.next(); // debe ignorarse
      tick(3000);

      expect(transport.disconnect).toHaveBeenCalledTimes(1);
      expect(transport.connect).toHaveBeenCalledTimes(1);
    }));
  });

  // ================================================================
  describe('calibraciones', () => {
    it('calibrateLevel() manda CMD_CALIBRATE_LEVEL, marca levelCalibrated$ y resetea las lecturas a 0 optimistamente', async () => {
      service.levelPressurePsi$.next(5); service.levelMm$.next(120); service.levelPercent$.next(40);

      await service.calibrateLevel();

      const calls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_CALIBRATE_LEVEL);
      expect(calls.length).toBe(1);
      expect(service.levelCalibrated$.value).toBeTrue();
      expect(service.levelPressurePsi$.value).toBe(0);
      expect(service.levelMm$.value).toBe(0);
      expect(service.levelPercent$.value).toBe(0);
    });

    it('calibrateLevelFull() manda CMD_CALIBRATE_LEVEL_FULL y marca levelFullCalibrated$', async () => {
      await service.calibrateLevelFull();
      const calls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_CALIBRATE_LEVEL_FULL);
      expect(calls.length).toBe(1);
      expect(service.levelFullCalibrated$.value).toBeTrue();
    });

    it('calibrateTiltReference() manda CMD_CALIBRATE_TILT_REF y marca tiltCalRefCaptured$', async () => {
      await service.calibrateTiltReference();
      const calls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_CALIBRATE_TILT_REF);
      expect(calls.length).toBe(1);
      expect(service.tiltCalRefCaptured$.value).toBeTrue();
    });

    it('calibrateTiltApply() OK: manda CMD_CALIBRATE_TILT_APPLY y desmarca tiltCalRefCaptured$', async () => {
      service.tiltCalRefCaptured$.next(true);
      await service.calibrateTiltApply();
      const calls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_CALIBRATE_TILT_APPLY);
      expect(calls.length).toBe(1);
      expect(service.tiltCalRefCaptured$.value).toBeFalse();
    });

    it('calibrateTiltApply() si falla (p.ej. BAD_VALUE por inclinación insuficiente): conserva tiltCalRefCaptured$ para poder reintentar el paso 2 sin repetir el paso 1', async () => {
      service.tiltCalRefCaptured$.next(true);
      transport.sendCmd.and.callFake((cmdType: number) =>
        cmdType === CMD_CALIBRATE_TILT_APPLY ? Promise.reject('BAD_VALUE') : Promise.resolve()
      );

      let error: any;
      try { await service.calibrateTiltApply(); } catch (e) { error = e; }

      expect(error).toBeDefined();
      expect(service.tiltCalRefCaptured$.value).toBeTrue(); // sigue en true, no se pierde el paso 1
    });

    it('calibrateHighPressureZero() manda CMD_CALIBRATE_HIGH_PRESSURE_ZERO, marca el cero e invalida cualquier referencia previa', async () => {
      service.highPressureRefCalibrated$.next(true); // referencia previa, debe invalidarse: ya no es coherente con el cero nuevo

      await service.calibrateHighPressureZero();

      const calls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_CALIBRATE_HIGH_PRESSURE_ZERO);
      expect(calls.length).toBe(1);
      expect(service.highPressureZeroCalibrated$.value).toBeTrue();
      expect(service.highPressureRefCalibrated$.value).toBeFalse();
    });

    it('calibrateHighPressureRef() valida el rango (0, 60] antes de mandar nada', async () => {
      let error: any;
      try { await service.calibrateHighPressureRef(0); } catch (e) { error = e; }
      expect(error).toBeDefined();

      error = undefined;
      try { await service.calibrateHighPressureRef(60.1); } catch (e) { error = e; }
      expect(error).toBeDefined();

      expect(transport.sendCmd).not.toHaveBeenCalled();
    });

    it('calibrateHighPressureRef() manda CMD_CALIBRATE_HIGH_PRESSURE_REF con refBar*100 en u16LE y marca la referencia calibrada', async () => {
      await service.calibrateHighPressureRef(18.5);

      const calls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_CALIBRATE_HIGH_PRESSURE_REF);
      expect(calls.length).toBe(1);
      const payload = calls[0][1] as Uint8Array;
      expect(Array.from(payload)).toEqual(u16LE(1850));
      expect(service.highPressureRefCalibrated$.value).toBeTrue();
    });
  });

  // ================================================================
  describe('setTankGeometry()', () => {
    it('valida heightMm en [100,5000] sin mandar nada si está fuera de rango', async () => {
      let error: any;
      try { await service.setTankGeometry(50, 0); } catch (e) { error = e; }
      expect(error).toBeDefined();

      error = undefined;
      try { await service.setTankGeometry(5001, 0); } catch (e) { error = e; }
      expect(error).toBeDefined();

      expect(transport.sendCmd).not.toHaveBeenCalled();
    });

    it('valida sensorLongitudinalOffsetMm en [-5000,5000] sin mandar nada si está fuera de rango', async () => {
      let error: any;
      try { await service.setTankGeometry(300, -5001); } catch (e) { error = e; }
      expect(error).toBeDefined();
      expect(transport.sendCmd).not.toHaveBeenCalled();
    });

    it('con valores válidos manda CMD_SET_TANK_GEOMETRY con el offset negativo en complemento a dos (i16 LE) y persiste', async () => {
      await service.setTankGeometry(450, -250);

      const calls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_SET_TANK_GEOMETRY);
      expect(calls.length).toBe(1);
      const payload = calls[0][1] as Uint8Array;
      expect(Array.from(payload)).toEqual([...u16LE(450), -250 & 0xFF, (-250 >> 8) & 0xFF]);

      expect(service.tankHeightMm$.value).toBe(450);
      expect(service.sensorLongitudinalOffsetMm$.value).toBe(-250);
      expect(localStorage.getItem(PREF_PREFIX + 'app.tankHeightMm')).toBe('450');
      expect(localStorage.getItem(PREF_PREFIX + 'app.sensorLongitudinalOffsetMm')).toBe('-250');
    });
  });

  // ================================================================
  describe('setHighPressureConfig()', () => {
    it('exige el margen mínimo HP_MIN_GAP_BAR entre reset/alarm/hardLimit, no solo una desigualdad estricta', async () => {
      // separación de solo 0.1 bar entre reset y alarm, por debajo de HP_MIN_GAP_BAR=0.5
      let error: any;
      try { await service.setHighPressureConfig(16.1, 16.0, 19.5); } catch (e) { error = e; }
      expect(error).toBeDefined();
      expect(transport.sendCmd).not.toHaveBeenCalled();
    });

    it('rechaza hardLimitBar por encima del fondo de escala físico del sensor (60 bar)', async () => {
      let error: any;
      try { await service.setHighPressureConfig(58, 57, 60.5); } catch (e) { error = e; }
      expect(error).toBeDefined();
      expect(transport.sendCmd).not.toHaveBeenCalled();
    });

    it('con valores válidos manda CMD_SET_HIGH_PRESSURE_CONFIG (alarm,reset,hardLimit *100, LE) y persiste', async () => {
      await service.setHighPressureConfig(18.0, 16.0, 19.5);

      const calls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_SET_HIGH_PRESSURE_CONFIG);
      expect(calls.length).toBe(1);
      const payload = calls[0][1] as Uint8Array;
      expect(Array.from(payload)).toEqual([...u16LE(1800), ...u16LE(1600), ...u16LE(1950)]);

      expect(service.highPressureAlarmBar$.value).toBe(18.0);
      expect(service.highPressureResetBar$.value).toBe(16.0);
      expect(service.highPressureHardLimitBar$.value).toBe(19.5);
      expect(localStorage.getItem(PREF_PREFIX + 'app.highPressureAlarmBar')).toBe('18');
    });
  });

  // ================================================================
  describe('loadConfigFromPreferences() — carga y valida lo persistido', () => {
    function setPref(key: string, value: string) {
      localStorage.setItem(PREF_PREFIX + 'app.' + key, value);
    }

    it('carga y aplica los valores simples guardados', async () => {
      setPref('thresholdCm', '80');
      setPref('hysteresisCm', '20');
      setPref('sourceMode', '1');
      setPref('mode', '1');
      setPref('enableLeft', '0');
      setPref('enableRight', '1');

      await service.loadConfigFromPreferences();

      expect(service.thresholdCm$.value).toBe(80);
      expect(service.hysteresisCm$.value).toBe(20);
      expect(service.sourceMode$.value).toBe(1);
      expect(service.mode$.value).toBe(1);
      expect(service.enabledLeft$.value).toBeFalse();
      expect(service.enabledRight$.value).toBeTrue();
    });

    it('recorta (clamp) al cargar los valores fuera de los límites de cordura, igual que hacen los setters', async () => {
      setPref('thresholdCm', '99999');         // por encima de 300
      setPref('hysteresisCm', '-5');            // por debajo de 0
      setPref('activeTimeModo1', '999999999');  // por encima de 600000

      await service.loadConfigFromPreferences();

      expect(service.thresholdCm$.value).toBe(300);
      expect(service.hysteresisCm$.value).toBe(0);
      expect(service.activeTimeModo1$.value).toBe(600000);
    });

    it('umbrales de alta presión: si lo guardado es coherente (margen mínimo respetado), los aplica', async () => {
      setPref('highPressureAlarmBar', '17');
      setPref('highPressureResetBar', '15');
      setPref('highPressureHardLimitBar', '20');

      await service.loadConfigFromPreferences();

      expect(service.highPressureAlarmBar$.value).toBe(17);
      expect(service.highPressureResetBar$.value).toBe(15);
      expect(service.highPressureHardLimitBar$.value).toBe(20);
    });

    it('umbrales de alta presión incoherentes (dato corrupto o de una versión antigua): se ignoran los tres y se mantienen los valores por defecto', async () => {
      const defaultAlarm = service.highPressureAlarmBar$.value;
      const defaultReset = service.highPressureResetBar$.value;
      const defaultHard  = service.highPressureHardLimitBar$.value;

      setPref('highPressureAlarmBar', '16');
      setPref('highPressureResetBar', '16'); // sin margen: alarm - reset = 0 < HP_MIN_GAP_BAR
      setPref('highPressureHardLimitBar', '19.5');

      await service.loadConfigFromPreferences();

      expect(service.highPressureAlarmBar$.value).toBe(defaultAlarm);
      expect(service.highPressureResetBar$.value).toBe(defaultReset);
      expect(service.highPressureHardLimitBar$.value).toBe(defaultHard);
    });

    it('geometría del depósito: dentro de los límites de cordura física, se aplica', async () => {
      setPref('tankHeightMm', '450');
      setPref('sensorLongitudinalOffsetMm', '-300');

      await service.loadConfigFromPreferences();

      expect(service.tankHeightMm$.value).toBe(450);
      expect(service.sensorLongitudinalOffsetMm$.value).toBe(-300);
    });

    it('geometría del depósito: fuera de los límites de cordura física, se ignora y mantiene el valor por defecto', async () => {
      const defaultHeight = service.tankHeightMm$.value;
      setPref('tankHeightMm', '50'); // por debajo de 100

      await service.loadConfigFromPreferences();

      expect(service.tankHeightMm$.value).toBe(defaultHeight);
    });
  });

  // ================================================================
  describe('saveConfigToPreferences() — formato de lo persistido', () => {
    it('guarda litersPerMin con un decimal fijo y numApplicators/grPerSec redondeados', async () => {
      service.litersPerMin$.next(1.2345);
      service.numApplicators$.next(3.6);
      service.grPerSec$.next(99.5);

      await service.saveConfigToPreferences();

      expect(localStorage.getItem(PREF_PREFIX + 'app.litersPerMin')).toBe('1.2');
      expect(localStorage.getItem(PREF_PREFIX + 'app.numApplicators')).toBe('4');
      expect(localStorage.getItem(PREF_PREFIX + 'app.grPerSec')).toBe('100');
    });

    it('guarda enabledLeft$/enabledRight$ como "1"/"0"', async () => {
      service.enabledLeft$.next(true);
      service.enabledRight$.next(false);

      await service.saveConfigToPreferences();

      expect(localStorage.getItem(PREF_PREFIX + 'app.enableLeft')).toBe('1');
      expect(localStorage.getItem(PREF_PREFIX + 'app.enableRight')).toBe('0');
    });

    it('un round-trip save -> load conserva los valores', async () => {
      service.thresholdCm$.next(123);
      service.retardoEntradaDist$.next(4500);
      service.activeTimeModo1$.next(2500);

      await service.saveConfigToPreferences();

      // Se "desordena" en memoria para comprobar que loadConfigFromPreferences()
      // de verdad relee de Preferences y no que el valor nunca cambió.
      service.thresholdCm$.next(5);
      service.retardoEntradaDist$.next(0);
      service.activeTimeModo1$.next(0);

      await service.loadConfigFromPreferences();

      expect(service.thresholdCm$.value).toBe(123);
      expect(service.retardoEntradaDist$.value).toBe(4500);
      expect(service.activeTimeModo1$.value).toBe(2500);
    });
  });
});
