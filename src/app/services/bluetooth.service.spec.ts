import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';

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
const CMD_SET_CONFIG = 0x02;
const CMD_GET_STATUS = 0x03;
const CMD_SET_ENABLE = 0x05;

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
      tick(300); // connect() espera 200ms tras requestStatus()/requestRelayStats()

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
      tick(300);

      const setEnableCalls = transport.sendCmd.calls.allArgs().filter(a => a[0] === CMD_SET_ENABLE);
      expect(setEnableCalls.length).toBe(0);
    }));

    it('llama a transport.adaptToProtocolVersion() al terminar la sincronización', fakeAsync(() => {
      service.connect(TEST_DEVICE);
      tick(300);
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
      tick(1200); // 800ms de espera interna de reconnect() + los ~300ms de connect()

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
      tick(1200);

      expect(transport.disconnect).toHaveBeenCalledTimes(1);
      expect(transport.connect).toHaveBeenCalledTimes(1);
    }));
  });
});
