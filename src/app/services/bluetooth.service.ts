import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Preferences } from '@capacitor/preferences';

import {
  BleTransportService,
  BluetoothDevice,
  LogEntry,
  LogLevel,
  CMD_PING,
  EVT_DIST,
  EVT_RELAY,
  EVT_SNAPSHOT,
  EVT_STATUS,
  EVT_RELAYSTAT,
  EVT_LEVEL,
  EVT_HIGH_PRESSURE,
} from './ble-transport.service';
// Reexportados para no romper ningún import existente en el resto de la app
// (p.ej. `import { BluetoothDevice } from '../services/bluetooth.service'`
// en bt-settings.page.ts) — estos tipos viven físicamente en
// ble-transport.service.ts desde que se partió el servicio.
export { BluetoothDevice, LogEntry, LogLevel } from './ble-transport.service';

// NOTA DE COMPATIBILIDAD (firmware v8):
// Los nombres "Relay"/"relé" se conservan porque el PROTOCOLO BINARIO sigue
// usando esos opcodes (EVT_RELAY 0x12, EVT_RELAYSTAT 0x15, etc). El hardware
// real ya NO usa relés electromecánicos, son salidas MOSFET. No es necesario
// cambiar esto: es solo una etiqueta heredada del protocolo, no afecta a nada.

// v8: separación mínima obligatoria entre los tres umbrales de alta presión
// (reset/alarm/hardLimit). Exportada para que cualquier UI que valide estos
// mismos umbrales (steppers, formularios) use exactamente el mismo valor y
// nunca puedan desincronizarse si algún día cambia.
// v15: el rango de alta presión pasó de 0-20 a 0-60 bar con incrementos de
// 0.5 bar (antes 0.1) — el margen mínimo se sube a juego, para que dos
// pasos consecutivos del stepper siempre lo cumplan de sobra.
export const HP_MIN_GAP_BAR = 0.5;

export type RelayStats = {
  L: { timeMs: number; activations: number };
  R: { timeMs: number; activations: number };
};
// Alias mas descriptivo del hardware real, mismo contenido que RelayStats.
export type OutputStats = RelayStats;

// ================================================================
// ⚠️ DEPRECADO: el firmware v8 eliminó por completo el sensor de flujo
// (YF-S201). Ya no existe ningún EVT_FLOW ni CMD_RESET_FLOW en el Arduino:
// el opcode 0x09 ahora es CMD_CALIBRATE_LEVEL y el opcode 0x17 ahora es
// EVT_LEVEL (nivel de atomizado por presión, no caudal).
// Se mantienen estos tipos/subjects por compatibilidad de código con otras
// partes de la app que puedan referenciarlos, pero YA NUNCA recibirán datos
// reales del Arduino: quedarán congelados en sus valores iniciales.
// Migra el código que los use hacia levelMm$ / levelPercent$ / etc.
// ================================================================
export type FlowState = 'OFF' | 'OK' | 'NO_FLOW';

// ================================================================
// Partición de servicio (sin cambiar comportamiento): todo lo que era
// framing/CRC, cola de comandos, parser RX, conexión/heartbeat/reconexión
// de bajo nivel y emparejamiento vive ahora en BleTransportService. Esta
// clase se queda como FACHADA de DOMINIO — decodifica los EVT_* del
// atomizador (nivel, alta presión, salidas, snapshot/status/stats),
// mantiene el estado público que ya consumían las páginas, y añade a
// connect()/disconnect() la sincronización de dominio (intención local de
// enable, requestStatus, persistencia) que antes vivía mezclada con el
// socket. La API pública (todo lo que las páginas usan vía `bt.xxx`) es
// exactamente la misma de antes.
// ================================================================
@Injectable({ providedIn: 'root' })
export class BluetoothService {

  // ================================================================
  // 🔵 ESTADOS PÚBLICOS — reexpuestos del transporte (misma instancia de
  // BehaviorSubject, no una copia: las páginas que ya guardaban
  // `this.isConnected$ = this.bt.isConnected$` siguen viendo exactamente
  // el mismo objeto observable de siempre).
  // ================================================================
  public isConnected$: BehaviorSubject<boolean>;
  public connectedDevice$: BehaviorSubject<BluetoothDevice | null>;
  public pairedDevices$: BehaviorSubject<BluetoothDevice[]>;
  public unpairedDevices$: BehaviorSubject<BluetoothDevice[]>;
  public logEntries$: BehaviorSubject<LogEntry[]>;
  public arduinoProtocolVersion$: BehaviorSubject<number>;

  public distanceLeft$  = new BehaviorSubject<number>(0);
  public distanceRight$ = new BehaviorSubject<number>(0);

  // ================================================================
  // 💧 [DEPRECADO] SENSOR DE FLUJO — ya no existe en el firmware v8.
  // Se conservan estos BehaviorSubject solo para no romper referencias en
  // otras partes de la app; nunca volverán a actualizarse con datos reales.
  // ================================================================
  /** @deprecated El firmware v8 no tiene sensor de flujo. Siempre 0. */
  public flowRateLMin$         = new BehaviorSubject<number>(0);
  /** @deprecated El firmware v8 no tiene sensor de flujo. Siempre 0. */
  public totalLitres$          = new BehaviorSubject<number>(0);
  /** @deprecated El firmware v8 no tiene sensor de flujo. Siempre false. */
  public flowDetected$         = new BehaviorSubject<boolean>(false);
  /** @deprecated El firmware v8 no tiene sensor de flujo. Siempre false. */
  public noFlowAlarm$          = new BehaviorSubject<boolean>(false);
  /** @deprecated El firmware v8 no tiene sensor de flujo. Siempre 'OFF'. */
  public flowState$            = new BehaviorSubject<FlowState>('OFF');
  /** @deprecated Dependía del sensor de flujo, ya no disponible. */
  public appliedProductGrMin$  = new BehaviorSubject<number>(0);
  /** @deprecated Dependía del sensor de flujo, ya no disponible. */
  public appliedProductGrHour$ = new BehaviorSubject<number>(0);
  /** @deprecated Dependía del sensor de flujo, ya no disponible. */
  public totalProductKg$       = new BehaviorSubject<number>(0);

  // Estos tres se mantienen porque siguen siendo parámetros de la app en sí
  // (no dependen del Arduino), aunque ahora mismo no alimentan ningún cálculo
  // de producto aplicado en tiempo real al no existir el sensor de flujo.
  public litersPerMin$   = new BehaviorSubject<number>(1.0);
  public numApplicators$ = new BehaviorSubject<number>(2);
  public grPerSec$       = new BehaviorSubject<number>(100);

  // ================================================================
  // 📏 NIVEL DE ATOMIZADO (presión de baja + compensación por inclinación)
  // Corresponde a EVT_LEVEL (0x17) del firmware v8/v9.
  // ================================================================
  /** Presión medida por el sensor de nivel, en psi (ya calibrada/filtrada). */
  public levelPressurePsi$ = new BehaviorSubject<number | null>(null);
  /** Nivel de líquido COMPENSADO por inclinación (firmware v9), en mm. */
  public levelMm$          = new BehaviorSubject<number | null>(null);
  /** Porcentaje de llenado del depósito (0-100). Solo llega vía EVT_LEVEL completo. */
  public levelPercent$     = new BehaviorSubject<number | null>(null);
  /** Inclinación combinada actual del depósito, en grados (informativa). */
  public tiltDeg$          = new BehaviorSubject<number | null>(null);
  /** true = medida de nivel fiable (inclinación dentro de límites); false = no fiable. */
  public levelValid$       = new BehaviorSubject<boolean>(false);

  // v10 (opción A): CMD_CALIBRATE_LEVEL (0x09) calibra conjuntamente el cero
  // de presión Y el plano del MPU6050 en una única operación.
  // v12: se ponen a `true` de inmediato al calibrar con éxito en esta misma
  // sesión (para respuesta instantánea en la UI), pero la fuente de verdad
  // real es el bit correspondiente que manda el firmware en cada
  // EVT_STATUS/EVT_SNAPSHOT (ver decodeLevelStatusExtension) — reflejando lo
  // que de verdad hay persistido en su EEPROM. Antes SOLO existía la parte
  // "de esta sesión": al reiniciar la app, ambos flags volvían a `false`
  // aunque el Arduino llevara tiempo calibrado, bloqueando "Calibrar lleno"
  // hasta recalibrar el vacío sin necesidad.
  public levelCalibrated$ = new BehaviorSubject<boolean>(false);

  // v11: segundo punto de calibración (CMD_CALIBRATE_LEVEL_FULL, 0x0B). Con
  // los dos puntos (vacío + lleno) el nivel se calcula por interpolación de
  // presiones en vez de asumir la densidad del líquido; mientras no se
  // calibre el punto lleno, el firmware sigue usando el modelo antiguo como
  // fallback. Ver nota de persistencia real junto a levelCalibrated$.
  public levelFullCalibrated$ = new BehaviorSubject<boolean>(false);

  // v11: geometría del depósito (antes constantes fijas en el firmware,
  // TANK_HEIGHT_MM / LEVEL_SENSOR_LONGITUDINAL_OFFSET_MM). Igual que los
  // umbrales de alta presión más abajo: el protocolo no tiene un comando de
  // "leer geometría", así que estos valores reflejan el default del firmware
  // o el último que esta misma app haya establecido con setTankGeometry().
  public tankHeightMm$               = new BehaviorSubject<number>(300);
  public sensorLongitudinalOffsetMm$ = new BehaviorSubject<number>(800);

  // ================================================================
  // 🔴 ALTA PRESIÓN (línea/bomba) + bloqueo de seguridad
  // Corresponde a EVT_HIGH_PRESSURE (0x18) del firmware v8.
  // ================================================================
  public highPressureBar$         = new BehaviorSubject<number | null>(null);
  public highPressureSensorFault$ = new BehaviorSubject<boolean>(false);
  /** true = el Arduino ha cortado AMBAS salidas por sobrepresión (lockout activo). */
  public highPressureLockout$     = new BehaviorSubject<boolean>(false);
  // v14: estado REAL de calibración del sensor de alta presión, persistido
  // en la EEPROM del Arduino — igual patrón que levelCalibrated$/
  // levelFullCalibrated$ (bits del byte añadido a EVT_HIGH_PRESSURE).
  public highPressureZeroCalibrated$ = new BehaviorSubject<boolean>(false);
  public highPressureRefCalibrated$  = new BehaviorSubject<boolean>(false);

  // Valores de umbral que la APP conoce/ha configurado. El protocolo actual
  // no tiene un comando de "leer configuración de alta presión", así que estos
  // reflejan los valores por defecto del firmware o el último valor que esta
  // misma app haya establecido con setHighPressureConfig(); si otro cliente
  // BT cambia los umbrales, esta app no se enterará hasta que se añada un
  // comando de lectura en un futuro firmware.
  public highPressureAlarmBar$     = new BehaviorSubject<number>(18.0);
  public highPressureResetBar$     = new BehaviorSubject<number>(16.0);
  public highPressureHardLimitBar$ = new BehaviorSubject<number>(19.5);

  // ================================================================
  // 🔀 SALIDAS (MOSFET) Y CONFIG
  // ================================================================
  // Nombres conservados por compatibilidad con el protocolo binario (ver nota
  // arriba); el hardware real son MOSFET, no relés electromecánicos.
  public relayLeft$  = new BehaviorSubject<boolean>(false);
  public relayRight$ = new BehaviorSubject<boolean>(false);

  public enabledLeft$  = new BehaviorSubject<boolean>(true);
  public enabledRight$ = new BehaviorSubject<boolean>(true);

  public sourceMode$ = new BehaviorSubject<0 | 1>(0);
  public mode$       = new BehaviorSubject<0 | 1>(0);

  public thresholdCm$        = new BehaviorSubject<number>(50);
  public hysteresisCm$       = new BehaviorSubject<number>(10);
  public retardoEntradaDist$ = new BehaviorSubject<number>(0);
  public retardoSalidaDist$  = new BehaviorSubject<number>(0);
  public retardoEntradaTemp$ = new BehaviorSubject<number>(0);
  public activeTimeModo1$    = new BehaviorSubject<number>(2000);

  public relayStats$ = new BehaviorSubject<RelayStats>({
    L: { timeMs: 0, activations: 0 },
    R: { timeMs: 0, activations: 0 },
  });

  public relayLeftTimeMs$       = new BehaviorSubject<number>(0);
  public relayLeftActivations$  = new BehaviorSubject<number>(0);
  public relayRightTimeMs$      = new BehaviorSubject<number>(0);
  public relayRightActivations$ = new BehaviorSubject<number>(0);

  // ================================================================
  // 🔑 KEYS PREFERENCES
  // ================================================================
  private readonly PREF_SOURCE_MODE     = 'app.sourceMode';
  private readonly PREF_MODE            = 'app.mode';
  private readonly PREF_THRESHOLD       = 'app.thresholdCm';
  private readonly PREF_HYSTERESIS      = 'app.hysteresisCm';
  private readonly PREF_RETARDO_IN_DIST = 'app.retardoEntradaDist';
  private readonly PREF_RETARDO_OUT_DIST= 'app.retardoSalidaDist';
  private readonly PREF_RETARDO_IN_TEMP = 'app.retardoEntradaTemp';
  private readonly PREF_ACTIVE_TIME     = 'app.activeTimeModo1';
  private readonly PREF_ENABLE_L        = 'app.enableLeft';
  private readonly PREF_ENABLE_R        = 'app.enableRight';
  private readonly PREF_LPM             = 'app.litersPerMin';
  private readonly PREF_APPS            = 'app.numApplicators';
  private readonly PREF_GRPS            = 'app.grPerSec';
  // v8: persistencia de los umbrales de alta presion (antes faltaba: se
  // actualizaban en memoria via setHighPressureConfig() pero nunca se
  // guardaban, asi que se perdian al reiniciar la app).
  private readonly PREF_HP_ALARM = 'app.highPressureAlarmBar';
  private readonly PREF_HP_RESET = 'app.highPressureResetBar';
  private readonly PREF_HP_HARD  = 'app.highPressureHardLimitBar';
  // v11: persistencia de la geometría del depósito (mismo motivo que arriba:
  // se actualiza en memoria via setTankGeometry() pero hay que guardarla para
  // no perderla al reiniciar la app).
  private readonly PREF_TANK_HEIGHT_MM   = 'app.tankHeightMm';
  private readonly PREF_SENSOR_LONG_MM   = 'app.sensorLongitudinalOffsetMm';

  // ================================================================
  // 🧩 PROTOCOLO — opcodes de COMANDOS (los EVT_*/ACK/RES_* de framing
  // viven en BleTransportService; estos CMD_* solo los usa esta fachada
  // para construir payloads de dominio).
  // ================================================================
  private readonly CMD_SET_CONFIG      = 0x02;
  private readonly CMD_GET_STATUS      = 0x03;
  private readonly CMD_GET_RELAYSTAT   = 0x04;
  private readonly CMD_SET_ENABLE      = 0x05;
  private readonly CMD_RESET_RELAYSTAT = 0x06;
  private readonly CMD_TEST_TRIGGER    = 0x07;
  private readonly CMD_EMERGENCY_STOP  = 0x08;
  // v8: 0x09 YA NO es "reset de flujo". El firmware no tiene sensor de flujo;
  // este opcode calibra CONJUNTAMENTE el cero del sensor de NIVEL y el plano
  // del MPU6050 (asume depósito vacío y equipo inmóvil en el estado que se
  // desea considerar "plano"). Es el ÚNICO comando de calibración de nivel
  // que existe en el firmware — no hay opcodes separados para "plano" o
  // "depósito lleno" (ver nota en levelCalibrated$ más arriba).
  private readonly CMD_CALIBRATE_LEVEL = 0x09;
  // v8: nuevo opcode, configura los umbrales de seguridad de alta presión.
  private readonly CMD_SET_HIGH_PRESSURE_CONFIG = 0x0A;
  // v11: calibra el punto "LLENO" del sensor de nivel (guarda la lectura ADC
  // cruda, igual que CMD_CALIBRATE_LEVEL guarda la de vacío). Sin payload.
  private readonly CMD_CALIBRATE_LEVEL_FULL = 0x0B;
  // v11: configura la geometría del depósito. Payload (4 bytes):
  // tankHeightMm(u16 LE), sensorLongitudinalOffsetMm(i16 LE, con signo).
  private readonly CMD_SET_TANK_GEOMETRY = 0x0C;
  // v13: autocalibración de sensorLongitudinalOffsetMm por inclinación, en
  // dos pasos, ninguno con payload. CMD_CALIBRATE_TILT_REF guarda la
  // presión/ángulo de referencia (equipo nivelado, cualquier nivel de
  // llenado); CMD_CALIBRATE_TILT_APPLY se manda después de inclinar el
  // equipo (el ángulo lo mide el propio MPU, no hace falta indicarlo) y
  // calcula+persiste la distancia. Ver nota completa junto a
  // calibrateTiltReference() más abajo.
  private readonly CMD_CALIBRATE_TILT_REF   = 0x0D;
  private readonly CMD_CALIBRATE_TILT_APPLY = 0x0E;
  // v14: calibración de 2 puntos del sensor de ALTA presión (línea/bomba).
  // ZERO sin payload (sin presión aplicada); REF con payload de 2 bytes
  // (refBar_x100, u16 LE) — la presión de referencia REAL que el usuario
  // está aplicando en ese momento con una fuente externa conocida.
  private readonly CMD_CALIBRATE_HIGH_PRESSURE_ZERO = 0x0F;
  // 0x10-0x18 están reservados para EVT_* (ver ble-transport.service.ts) —
  // se salta al primer hueco libre después del rango de eventos para no
  // mezclar los dos rangos de numeración (ver nota idéntica en el .ino).
  private readonly CMD_CALIBRATE_HIGH_PRESSURE_REF  = 0x19;

  // ================================================================
  // 🧱 INTERNOS
  // ================================================================
  private cfgTimer: any = null;
  private cfgInFlight = false;
  private cfgDirty    = false;
  private readonly CFG_DEBOUNCE_MS = 300;

  // Fix de partición: la orquestación completa de la reconexión (no solo el
  // socket) vive aquí porque necesita rehacer la sincronización de dominio
  // — ver connect() más abajo. El transporte solo avisa vía
  // transport.reconnectRequested$ (suscrito en el constructor) cuando su
  // heartbeat considera el enlace muerto.
  private reconnecting = false;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private reconnectAttempts = 0;

  constructor(private zone: NgZone, private transport: BleTransportService) {
    this.isConnected$            = this.transport.isConnected$;
    this.connectedDevice$        = this.transport.connectedDevice$;
    this.pairedDevices$          = this.transport.pairedDevices$;
    this.unpairedDevices$        = this.transport.unpairedDevices$;
    this.logEntries$             = this.transport.logEntries$;
    this.arduinoProtocolVersion$ = this.transport.arduinoProtocolVersion$;

    this.transport.frame$.subscribe(f => this.dispatchDomainFrame(f.type, f.payload));
    this.transport.reconnectRequested$.subscribe(() => this.reconnect().catch(() => {}));

    this.loadConfigFromPreferences().catch(err =>
      console.error('Error cargando config inicial:', err)
    );
  }

  // ================================================================
  // 📋 LOG — delegado al transporte (mismo logEntries$ reexpuesto arriba).
  // Se mantiene el mismo nombre de método (`log`) para que el resto de esta
  // clase (calibraciones, config, etc.) no tenga que cambiar ni una línea.
  // ================================================================
  get logEnabled(): boolean { return this.transport.logEnabled; }
  set logEnabled(v: boolean) { this.transport.logEnabled = v; }

  private log(level: LogLevel, category: string, msg: string, data?: any) {
    this.transport.log(level, category, msg, data);
  }

  public clearLog() { this.transport.clearLog(); }

  // Envoltorio fino sobre transport.sendCmd() — mismo nombre que antes para
  // no tocar ninguna de las llamadas `this.sendCmd(...)` de más abajo.
  private sendCmd(
    cmdType: number,
    payload?: Uint8Array,
    timeoutMs = 3000,
    priority: 'high' | 'low' = 'high',
    attempts?: number,
  ): Promise<void> {
    return this.transport.sendCmd(cmdType, payload, timeoutMs, priority, attempts);
  }

  // ================================================================
  // 💾 PERSISTENCIA
  // ================================================================
  async saveConfigToPreferences(): Promise<void> {
    try {
      await Promise.all([
        Preferences.set({ key: this.PREF_SOURCE_MODE,      value: String(this.sourceMode$.value) }),
        Preferences.set({ key: this.PREF_MODE,             value: String(this.mode$.value) }),
        Preferences.set({ key: this.PREF_THRESHOLD,        value: String(this.thresholdCm$.value) }),
        Preferences.set({ key: this.PREF_HYSTERESIS,       value: String(this.hysteresisCm$.value) }),
        Preferences.set({ key: this.PREF_RETARDO_IN_DIST,  value: String(this.retardoEntradaDist$.value) }),
        Preferences.set({ key: this.PREF_RETARDO_OUT_DIST, value: String(this.retardoSalidaDist$.value) }),
        Preferences.set({ key: this.PREF_RETARDO_IN_TEMP,  value: String(this.retardoEntradaTemp$.value) }),
        Preferences.set({ key: this.PREF_ACTIVE_TIME,      value: String(this.activeTimeModo1$.value) }),
        Preferences.set({ key: this.PREF_ENABLE_L,         value: String(this.enabledLeft$.value  ? 1 : 0) }),
        Preferences.set({ key: this.PREF_ENABLE_R,         value: String(this.enabledRight$.value ? 1 : 0) }),
        Preferences.set({ key: this.PREF_LPM,              value: String(this.litersPerMin$.value.toFixed(1)) }),
        Preferences.set({ key: this.PREF_APPS,             value: String(Math.round(this.numApplicators$.value)) }),
        Preferences.set({ key: this.PREF_GRPS,             value: String(Math.round(this.grPerSec$.value)) }),
        Preferences.set({ key: this.PREF_HP_ALARM,         value: String(this.highPressureAlarmBar$.value) }),
        Preferences.set({ key: this.PREF_HP_RESET,         value: String(this.highPressureResetBar$.value) }),
        Preferences.set({ key: this.PREF_HP_HARD,          value: String(this.highPressureHardLimitBar$.value) }),
        Preferences.set({ key: this.PREF_TANK_HEIGHT_MM,   value: String(this.tankHeightMm$.value) }),
        Preferences.set({ key: this.PREF_SENSOR_LONG_MM,   value: String(this.sensorLongitudinalOffsetMm$.value) }),
      ]);
      this.log('debug', 'PREFS', 'Parámetros guardados en Preferences', {
        sourceMode:         this.sourceMode$.value,
        mode:               this.mode$.value,
        thresholdCm:        this.thresholdCm$.value,
        hysteresisCm:       this.hysteresisCm$.value,
        retardoEntradaDist: this.retardoEntradaDist$.value,
        retardoSalidaDist:  this.retardoSalidaDist$.value,
        retardoEntradaTemp: this.retardoEntradaTemp$.value,
        activeTimeModo1:    this.activeTimeModo1$.value,
        enableLeft:         this.enabledLeft$.value,
        enableRight:        this.enabledRight$.value,
      });
    } catch (err) {
      this.log('error', 'PREFS', 'Error guardando en Preferences', err);
      throw err;
    }
  }

  async loadConfigFromPreferences(): Promise<void> {
    try {
      const [srcMode, mode, thr, hys, inD, outD, inT, actT, enL, enR, lpm, apps, grps, hpAlarm, hpReset, hpHard, tankH, sensorL] = await Promise.all([
        Preferences.get({ key: this.PREF_SOURCE_MODE }),
        Preferences.get({ key: this.PREF_MODE }),
        Preferences.get({ key: this.PREF_THRESHOLD }),
        Preferences.get({ key: this.PREF_HYSTERESIS }),
        Preferences.get({ key: this.PREF_RETARDO_IN_DIST }),
        Preferences.get({ key: this.PREF_RETARDO_OUT_DIST }),
        Preferences.get({ key: this.PREF_RETARDO_IN_TEMP }),
        Preferences.get({ key: this.PREF_ACTIVE_TIME }),
        Preferences.get({ key: this.PREF_ENABLE_L }),
        Preferences.get({ key: this.PREF_ENABLE_R }),
        Preferences.get({ key: this.PREF_LPM }),
        Preferences.get({ key: this.PREF_APPS }),
        Preferences.get({ key: this.PREF_GRPS }),
        Preferences.get({ key: this.PREF_HP_ALARM }),
        Preferences.get({ key: this.PREF_HP_RESET }),
        Preferences.get({ key: this.PREF_HP_HARD }),
        Preferences.get({ key: this.PREF_TANK_HEIGHT_MM }),
        Preferences.get({ key: this.PREF_SENSOR_LONG_MM }),
      ]);

      this.zone.run(() => {
        if (srcMode.value !== null) { const sm = Number(srcMode.value); this.sourceMode$.next(sm === 1 ? 1 : 0); }
        if (mode.value   !== null) { const m  = Number(mode.value);   this.mode$.next(m === 1 ? 1 : 0); }
        if (thr.value)   this.thresholdCm$.next(Math.max(5,   Math.min(300,    Number(thr.value))));
        if (hys.value)   this.hysteresisCm$.next(Math.max(0,  Math.min(100,    Number(hys.value))));
        if (inD.value)   this.retardoEntradaDist$.next(Math.max(0, Math.min(60000,  Number(inD.value))));
        if (outD.value)  this.retardoSalidaDist$.next(Math.max(0,  Math.min(60000,  Number(outD.value))));
        if (inT.value)   this.retardoEntradaTemp$.next(Math.max(0, Math.min(60000,  Number(inT.value))));
        if (actT.value)  this.activeTimeModo1$.next(Math.max(0,    Math.min(600000, Number(actT.value))));
        if (enL.value  !== null) this.enabledLeft$.next(Number(enL.value)  !== 0);
        if (enR.value  !== null) this.enabledRight$.next(Number(enR.value) !== 0);
        if (lpm.value)   this.litersPerMin$.next(Math.max(0, Number(lpm.value)));
        if (apps.value)  this.numApplicators$.next(Math.max(1, Math.round(Number(apps.value))));
        if (grps.value)  this.grPerSec$.next(Math.max(0, Math.round(Number(grps.value))));

        // v8: cargar umbrales de alta presion, validando la misma coherencia
        // que setHighPressureConfig() (reset < alarm < hardLimit <= 60 bar,
        // v15: antes 20).
        // Si lo guardado no es coherente (versión antigua, dato corrupto),
        // se ignoran los tres y se mantienen los valores por defecto.
        if (hpAlarm.value && hpReset.value && hpHard.value) {
          const a = Number(hpAlarm.value);
          const r = Number(hpReset.value);
          const h = Number(hpHard.value);
          if (r >= 0 && (a - r) >= HP_MIN_GAP_BAR && (h - a) >= HP_MIN_GAP_BAR && h <= 60) {
            this.highPressureAlarmBar$.next(a);
            this.highPressureResetBar$.next(r);
            this.highPressureHardLimitBar$.next(h);
          }
        }

        // v11: cargar geometría del depósito, con los mismos límites de
        // cordura física que valida setTankGeometry()/el firmware.
        if (tankH.value) {
          const h = Number(tankH.value);
          if (h >= 100 && h <= 5000) this.tankHeightMm$.next(Math.round(h));
        }
        if (sensorL.value !== null) {
          const off = Number(sensorL.value);
          if (off >= -5000 && off <= 5000) this.sensorLongitudinalOffsetMm$.next(Math.round(off));
        }
      });
    } catch (err) {
      console.error('⚠️ Error cargando Preferences:', err);
    }
  }

  // ================================================================
  // 🔎 ESCANEO / EMPAREJAMIENTO — pura delegación al transporte, sin lógica
  // de dominio añadida.
  // ================================================================
  async listPairedDevices(): Promise<BluetoothDevice[]> { return this.transport.listPairedDevices(); }
  async loadPairedDevices(): Promise<void> { return this.transport.loadPairedDevices(); }
  async unpairDevice(address: string): Promise<void> { return this.transport.unpairDevice(address); }
  async unpairAllPaired(): Promise<{ removed: number; failed: { device: BluetoothDevice; error: any }[] }> {
    return this.transport.unpairAllPaired();
  }
  async scanForUnpaired(): Promise<void> { return this.transport.scanForUnpaired(); }

  // ================================================================
  // 🔌 CONEXIÓN — el socket lo abre/cierra el transporte; aquí se añade la
  // sincronización de DOMINIO que antes vivía mezclada dentro del mismo
  // connect()/disconnect() monolítico.
  // ================================================================
  async connect(deviceOrAddress: BluetoothDevice | string): Promise<void> {
    await this.transport.connect(deviceOrAddress);

    // Fix: instantánea de la intención LOCAL antes de pedir el estado real.
    // requestStatus() va a sobrescribir enabledLeft$/enabledRight$ con lo
    // que diga el Arduino (EVT_STATUS) — esta es la única forma de conservar
    // "lo que el usuario quería" (p.ej. tocó el interruptor estando
    // desconectado) para poder compararlo después.
    const intendedLeft  = this.enabledLeft$.value;
    const intendedRight = this.enabledRight$.value;

    this.log('debug', 'CONNECT', 'Solicitando status y relay stats...');
    const statusOk = await this.requestStatus()
      .then(() => true)
      .catch(e => { this.log('warn', 'CONNECT', 'requestStatus falló', e); return false; });
    await this.requestRelayStats().catch(e => this.log('warn', 'CONNECT', 'requestRelayStats falló', e));

    await new Promise(r => setTimeout(r, 200));

    // Fix: antes esto SOLO empujaba el sentido "deshabilitado", y encima
    // usando enabledLeft$/enabledRight$ tal cual estuvieran en ese momento —
    // que si requestStatus() había fallado, era el caché LOCAL (antes de
    // este fix, potencialmente corrupto por el bug de setSideEnabled() de
    // arriba), y si había tenido éxito, ya era la verdad del Arduino,
    // haciendo el envío redundante. Ahora: si requestStatus() confirmó el
    // estado real y difiere de la intención local (el usuario tocó el
    // interruptor mientras estaba desconectado), se manda esa intención en
    // CUALQUIER sentido, no solo para apagar. Si requestStatus() falló, no
    // hay verdad de terreno fiable — no se empuja nada a ciegas; el
    // heartbeat/reconexión y el próximo sondeo ya se encargarán de
    // resincronizar en cuanto el enlace responda.
    if (statusOk) {
      if (this.enabledLeft$.value !== intendedLeft) {
        this.log('info', 'CONNECT', `Sincronizando enable L=${intendedLeft} al Arduino (intención local)`);
        const plL = new Uint8Array(2); plL[0] = 'L'.charCodeAt(0); plL[1] = intendedLeft ? 1 : 0;
        await this.sendCmd(this.CMD_SET_ENABLE, plL, 2000).catch(e => this.log('warn', 'CONNECT', 'SET_ENABLE L falló', e));
      }
      if (this.enabledRight$.value !== intendedRight) {
        this.log('info', 'CONNECT', `Sincronizando enable R=${intendedRight} al Arduino (intención local)`);
        const plR = new Uint8Array(2); plR[0] = 'R'.charCodeAt(0); plR[1] = intendedRight ? 1 : 0;
        await this.sendCmd(this.CMD_SET_ENABLE, plR, 2000).catch(e => this.log('warn', 'CONNECT', 'SET_ENABLE R falló', e));
      }
    } else {
      this.log('warn', 'CONNECT', 'Estado real del Arduino no confirmado — no se fuerza ningún enable a ciegas');
    }

    await this.saveConfigToPreferences().catch(e => this.log('warn', 'CONNECT', 'saveConfig falló', e));
    this.transport.adaptToProtocolVersion();
    this.log('info', 'CONNECT', 'Conexión completada', { enableL: this.enabledLeft$.value, enableR: this.enabledRight$.value });
  }

  async disconnect(): Promise<void> {
    if (this.cfgTimer) { clearTimeout(this.cfgTimer); this.cfgTimer = null; }
    this.cfgDirty = false;
    this.cfgInFlight = false;
    this.transport.pauseHeartbeat = false;
    await this.transport.disconnect();
  }

  // ================================================================
  // RECONEXIÓN — disparada por transport.reconnectRequested$ (heartbeat
  // muerto). Vive aquí, no en el transporte, porque reconectar de verdad
  // implica rehacer la sincronización de dominio de connect() de arriba,
  // no solo reabrir el socket.
  // ================================================================
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    // Capturado ANTES de desconectar (disconnect() pone connectedDevice$ a
    // null) — mismo motivo que capturar `this.device` antes en la versión
    // previa monolítica.
    const dev = this.connectedDevice$.value;
    if (!dev) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) return;

    this.reconnecting = true;
    this.reconnectAttempts++;

    try {
      // No hace falta esperar aquí a que la cola de comandos se vacíe: en
      // cuanto disconnect() pone isConnected$ a false, cualquier comando en
      // curso o en cola falla de inmediato (ver BleTransportService), así
      // que el worker se libera solo casi al instante.
      try { await this.disconnect(); } catch {}
      await new Promise(r => setTimeout(r, 800));
      try { await this.connect(dev); this.reconnectAttempts = 0; } catch {}
    } finally {
      this.reconnecting = false;
    }
  }

  // ================================================================
  // DISPATCH — decodifica en el DOMINIO las tramas que el transporte no
  // gestiona internamente (todo menos ACK/EVT_BOOT/EVT_KEEPALIVE, ver
  // BleTransportService.dispatchFrame).
  // ================================================================
  private u16LE(p: Uint8Array, o: number): number { return (p[o] | (p[o+1] << 8)) & 0xFFFF; }
  private u32LE(p: Uint8Array, o: number): number { return ((p[o]) | (p[o+1] << 8) | (p[o+2] << 16) | (p[o+3] << 24)) >>> 0; }

  // ================================================================
  // 📏 NIVEL — decodificadores (firmware v8/v9)
  //
  // OJO: EVT_LEVEL (8 bytes) y la extensión de 7 bytes dentro de
  // EVT_STATUS/EVT_SNAPSHOT NO tienen el mismo orden de campos ni el mismo
  // tamaño (la extensión no incluye el porcentaje). Por eso son DOS
  // decodificadores distintos, no el mismo con un offset distinto.
  // ================================================================

  /** Decodifica EVT_LEVEL (0x17) completo: 8 bytes. */
  private decodeLevelPayload(payload: Uint8Array, offset = 0): boolean {
    if (payload.length < offset + 8) return false;

    const pressurePsi = this.u16LE(payload, offset)     / 100.0;
    const levelMm     = this.u16LE(payload, offset + 2);
    const percent     = this.u16LE(payload, offset + 4) / 10.0;
    const tiltDeg     = payload[offset + 6];
    const valid       = payload[offset + 7] === 1;

    this.zone.run(() => {
      this.levelPressurePsi$.next(pressurePsi);
      this.levelMm$.next(levelMm);
      this.levelPercent$.next(percent);
      this.tiltDeg$.next(tiltDeg);
      this.levelValid$.next(valid);
    });

    return true;
  }

  /**
   * Decodifica la extensión de 7 bytes de nivel dentro de EVT_STATUS/
   * EVT_SNAPSHOT. Orden de campos DISTINTO al de EVT_LEVEL: aquí es
   * [levelMm, pressurePsi, tiltDeg, valid, calibración] y NO incluye el
   * porcentaje (ese solo llega completo vía EVT_LEVEL).
   *
   * Fix: el último byte era "reservado" (firmware siempre mandaba 0x00), y
   * levelCalibrated$/levelFullCalibrated$ SOLO se ponían a true en memoria
   * tras una calibración hecha en la misma sesión de la app — se perdían en
   * cada reinicio aunque el Arduino llevara tiempo calibrado, bloqueando
   * "Calibrar lleno" hasta recalibrar el vacío sin necesidad. Ahora el
   * firmware manda aquí el estado REAL persistido en su EEPROM (bit0 =
   * vacío calibrado, bit1 = lleno calibrado — ver calibracionBitmask() en
   * el .ino), así que se sincroniza solo con cada EVT_STATUS/EVT_SNAPSHOT,
   * sin depender de que esta sesión concreta haya calibrado nada.
   */
  private decodeLevelStatusExtension(payload: Uint8Array, offset: number): boolean {
    if (payload.length < offset + 7) return false;

    const levelMm     = this.u16LE(payload, offset);
    const pressurePsi = this.u16LE(payload, offset + 2) / 100.0;
    const tiltDeg     = payload[offset + 4];
    const valid       = payload[offset + 5] === 1;
    const calibBits   = payload[offset + 6];
    const zeroCalibrated = (calibBits & 0x01) !== 0;
    const fullCalibrated = (calibBits & 0x02) !== 0;

    // v13: sensorLongitudinalOffsetMm (i16 LE con signo), 2 bytes añadidos al
    // final tras el bitmask de calibración — extensión retrocompatible: un
    // firmware anterior a v13 simplemente no manda estos 2 bytes, el guard de
    // longitud lo detecta y se deja sensorLongitudinalOffsetMm$ como estaba
    // (el último valor conocido/por defecto), igual que ya pasaba con toda
    // la geometría del depósito antes de existir un comando de lectura.
    const haveTiltOffset = payload.length >= offset + 9;
    const tiltOffsetMm = haveTiltOffset
      ? ((this.u16LE(payload, offset + 7) << 16) >> 16) // reinterpretar u16 como i16 con signo
      : null;

    this.zone.run(() => {
      this.levelMm$.next(levelMm);
      this.levelPressurePsi$.next(pressurePsi);
      this.tiltDeg$.next(tiltDeg);
      this.levelValid$.next(valid);
      this.levelCalibrated$.next(zeroCalibrated);
      this.levelFullCalibrated$.next(fullCalibrated);
      if (tiltOffsetMm !== null) this.sensorLongitudinalOffsetMm$.next(tiltOffsetMm);
    });

    return true;
  }

  // ================================================================
  // 🔴 ALTA PRESIÓN — decodificador (firmware v8, EVT_HIGH_PRESSURE 0x18)
  // ================================================================
  private decodeHighPressurePayload(payload: Uint8Array): boolean {
    if (payload.length < 4) return false;

    // v8: el firmware codifica bar*100 (NO bar*10). Dividir entre 100.
    const bar         = this.u16LE(payload, 0) / 100.0;
    const sensorFault = payload[2] === 1;
    const lockout     = payload[3] === 1;
    // v14: byte 5 añadido al final (retrocompatible, igual patrón que la
    // extensión de nivel): bit0 = cero calibrado, bit1 = referencia
    // calibrada. Un firmware anterior a v14 simplemente no lo manda.
    const haveCalibBits = payload.length >= 5;
    const calibBits = haveCalibBits ? payload[4] : 0;

    this.zone.run(() => {
      this.highPressureBar$.next(bar);
      this.highPressureSensorFault$.next(sensorFault);
      this.highPressureLockout$.next(lockout);
      if (haveCalibBits) {
        this.highPressureZeroCalibrated$.next((calibBits & 0x01) !== 0);
        this.highPressureRefCalibrated$.next((calibBits & 0x02) !== 0);
      }
    });

    return true;
  }

  private dispatchDomainFrame(type: number, payload: Uint8Array) {
    switch (type) {
      case EVT_DIST: {
        if (payload.length < 3) return;
        const side = String.fromCharCode(payload[0]);
        const cm   = this.u16LE(payload, 1);
        this.zone.run(() => {
          if (side === 'L') this.distanceLeft$.next(cm);
          if (side === 'R') this.distanceRight$.next(cm);
        });
        return;
      }

      case EVT_RELAY: {
        if (payload.length < 3) return;
        const side      = String.fromCharCode(payload[0]);
        const relayOn   = payload[1] === 1;
        const modeRelay = payload[2];
        const modoTexto = modeRelay === 1 ? 'temporizado' : 'detección continua';
        const sourceTexto = this.sourceMode$.value === 1 ? 'entrada PC817' : 'ultrasonido';

        if (relayOn) {
          const timerInfo = modeRelay === 1
            ? `— durará ${(this.activeTimeModo1$.value / 1000).toFixed(2)}s (timer)`
            : '— activo mientras haya detección';
          this.log('info', 'OUTPUT', `🟢 SALIDA ${side} ON — modo=${modoTexto} fuente=${sourceTexto} ${timerInfo}`);
        } else {
          this.log('info', 'OUTPUT', `🔴 SALIDA ${side} OFF — modo=${modoTexto}`);
        }

        this.zone.run(() => {
          if (side === 'L') this.relayLeft$.next(relayOn);
          if (side === 'R') this.relayRight$.next(relayOn);
        });
        return;
      }

      case EVT_SNAPSHOT: {
        if (payload.length < 20) return;
        const Lr      = payload[0] === 1;
        const Rr      = payload[1] === 1;
        const enL     = payload[2] === 1;
        const enR     = payload[3] === 1;
        const srcMode = payload[4];
        const m       = payload[5] === 1 ? 1 : 0;
        const thr     = this.u16LE(payload, 6);
        const hys     = this.u16LE(payload, 8);
        const in0     = this.u16LE(payload, 10);
        const out0    = this.u16LE(payload, 12);
        const in1     = this.u16LE(payload, 14);
        const active1 = this.u32LE(payload, 16);
        this.zone.run(() => {
          this.relayLeft$.next(Lr);     this.relayRight$.next(Rr);
          this.enabledLeft$.next(enL);  this.enabledRight$.next(enR);
          this.sourceMode$.next(srcMode === 1 ? 1 : 0);
          this.mode$.next(m as 0|1);
          this.thresholdCm$.next(thr);  this.hysteresisCm$.next(hys);
          this.retardoEntradaDist$.next(in0); this.retardoSalidaDist$.next(out0);
          this.retardoEntradaTemp$.next(in1); this.activeTimeModo1$.next(active1);
        });
        // v8: bytes 20-26 = extension de NIVEL (no de flujo). Ver nota arriba
        // sobre por qué es un decodificador distinto al de EVT_LEVEL.
        if (payload.length >= 27) this.decodeLevelStatusExtension(payload, 20);
        return;
      }

      case EVT_STATUS: {
        if (payload.length < 24) return;
        const dL      = this.u16LE(payload, 0);
        const dR      = this.u16LE(payload, 2);
        const RL      = payload[4] === 1;
        const RR      = payload[5] === 1;
        const enL     = payload[6] === 1;
        const enR     = payload[7] === 1;
        const srcMode = payload[8];
        const m       = payload[9] === 1 ? 1 : 0;
        const thr     = this.u16LE(payload, 10);
        const hys     = this.u16LE(payload, 12);
        const in0     = this.u16LE(payload, 14);
        const out0    = this.u16LE(payload, 16);
        const in1     = this.u16LE(payload, 18);
        const active1 = this.u32LE(payload, 20);
        this.zone.run(() => {
          this.distanceLeft$.next(dL);  this.distanceRight$.next(dR);
          this.relayLeft$.next(RL);     this.relayRight$.next(RR);
          this.enabledLeft$.next(enL);  this.enabledRight$.next(enR);
          this.sourceMode$.next(srcMode === 1 ? 1 : 0);
          this.mode$.next(m as 0|1);
          this.thresholdCm$.next(thr);  this.hysteresisCm$.next(hys);
          this.retardoEntradaDist$.next(in0); this.retardoSalidaDist$.next(out0);
          this.retardoEntradaTemp$.next(in1); this.activeTimeModo1$.next(active1);
        });
        // v8: bytes 24-30 = extension de NIVEL (no de flujo).
        if (payload.length >= 31) this.decodeLevelStatusExtension(payload, 24);
        return;
      }

      case EVT_RELAYSTAT: {
        if (payload.length < 16) return;
        const leftTime  = this.u32LE(payload, 0);
        const leftActs  = this.u32LE(payload, 4);
        const rightTime = this.u32LE(payload, 8);
        const rightActs = this.u32LE(payload, 12);
        this.zone.run(() => {
          this.relayLeftTimeMs$.next(leftTime);
          this.relayLeftActivations$.next(leftActs);
          this.relayRightTimeMs$.next(rightTime);
          this.relayRightActivations$.next(rightActs);
          this.relayStats$.next({
            L: { timeMs: leftTime,  activations: leftActs  },
            R: { timeMs: rightTime, activations: rightActs },
          });
        });
        return;
      }

      // v8: 0x17 ahora es EVT_LEVEL (nivel de atomizado), no flujo.
      case EVT_LEVEL:
        this.decodeLevelPayload(payload, 0);
        return;

      // v8: nuevo opcode, alta presión + estado de bloqueo de seguridad.
      case EVT_HIGH_PRESSURE:
        this.decodeHighPressurePayload(payload);
        return;
    }
  }

  // ================================================================
  // CONFIG
  // ================================================================
  private scheduleConfigSend() {
    this.cfgDirty = true;
    if (this.cfgTimer) clearTimeout(this.cfgTimer);
    this.cfgTimer = setTimeout(() => { this.flushConfig().catch(() => {}); }, this.CFG_DEBOUNCE_MS);
  }

  private snapshotConfig() {
    return {
      sourceMode:         (this.sourceMode$.value ?? 0) as 0 | 1,
      mode:               (this.mode$.value ?? 0) as 0 | 1,
      thresholdCm:        Math.round(this.thresholdCm$.value),
      hysteresisCm:       Math.round(this.hysteresisCm$.value),
      retardoEntradaDist: Math.round(this.retardoEntradaDist$.value),
      retardoSalidaDist:  Math.round(this.retardoSalidaDist$.value),
      retardoEntradaTemp: Math.round(this.retardoEntradaTemp$.value),
      activeTimeModo1:    Math.round(this.activeTimeModo1$.value),
    };
  }

  private validateConfig(c: ReturnType<BluetoothService['snapshotConfig']>) {
    if (!(c.sourceMode === 0 || c.sourceMode === 1))  throw new Error('BAD_VALUE');
    if (!(c.mode === 0 || c.mode === 1))              throw new Error('BAD_VALUE');
    if (c.thresholdCm < 5 || c.thresholdCm > 300)    throw new Error('BAD_VALUE');
    if (c.hysteresisCm < 0 || c.hysteresisCm > 100)  throw new Error('BAD_VALUE');
    if (c.retardoEntradaDist < 0 || c.retardoEntradaDist > 60000) throw new Error('BAD_VALUE');
    if (c.retardoSalidaDist  < 0 || c.retardoSalidaDist  > 60000) throw new Error('BAD_VALUE');
    if (c.retardoEntradaTemp < 0 || c.retardoEntradaTemp > 60000) throw new Error('BAD_VALUE');
    if (c.activeTimeModo1 < 0 || c.activeTimeModo1 > 600000)      throw new Error('BAD_VALUE');
  }

  private buildConfigPayload(c: ReturnType<BluetoothService['snapshotConfig']>): Uint8Array {
    const pl = new Uint8Array(16);
    let o = 0;
    pl[o++] = c.sourceMode & 0xFF;
    pl[o++] = c.mode & 0xFF;
    pl[o++] = c.thresholdCm & 0xFF;        pl[o++] = (c.thresholdCm >> 8) & 0xFF;
    pl[o++] = c.hysteresisCm & 0xFF;       pl[o++] = (c.hysteresisCm >> 8) & 0xFF;
    pl[o++] = c.retardoEntradaDist & 0xFF; pl[o++] = (c.retardoEntradaDist >> 8) & 0xFF;
    pl[o++] = c.retardoSalidaDist & 0xFF;  pl[o++] = (c.retardoSalidaDist >> 8) & 0xFF;
    pl[o++] = c.retardoEntradaTemp & 0xFF; pl[o++] = (c.retardoEntradaTemp >> 8) & 0xFF;
    const a = c.activeTimeModo1 >>> 0;
    pl[o++] = a & 0xFF; pl[o++] = (a >> 8) & 0xFF; pl[o++] = (a >> 16) & 0xFF; pl[o++] = (a >> 24) & 0xFF;
    return pl;
  }

  private async flushConfig(): Promise<void> {
    if (!this.isConnected$.value || this.cfgInFlight || !this.cfgDirty) {
      this.log('debug', 'CONFIG', `flushConfig omitido — connected=${this.isConnected$.value} inFlight=${this.cfgInFlight} dirty=${this.cfgDirty}`);
      return;
    }
    this.cfgInFlight = true;
    this.transport.pauseHeartbeat = true;
    this.cfgDirty    = false;
    const desired = this.snapshotConfig();
    this.log('info', 'CONFIG', 'Enviando CMD_SET_CONFIG', desired);
    // Fix: validateConfig() estaba FUERA del try/finally — si lanzaba,
    // cfgInFlight se quedaba en `true` para siempre (el finally que lo
    // resetea nunca llegaba a ejecutarse), y como el guard de arriba
    // descarta silenciosamente cualquier flushConfig() futuro mientras
    // cfgInFlight sea true, todos los "Aplicar" posteriores quedaban
    // colgados sin ACK, sin error y sin log — indistinguible desde la UI
    // de un cuelgue real del enlace BT.
    try {
      this.validateConfig(desired);
      await this.sendCmd(this.CMD_SET_CONFIG, this.buildConfigPayload(desired), 3000);
      this.log('info', 'CONFIG', 'CMD_SET_CONFIG — ACK OK');
      await this.saveConfigToPreferences();
    } catch(e) {
      this.log('error', 'CONFIG', 'CMD_SET_CONFIG — falló', e);
      // Fix: antes el error se registraba y se TRAGABA aquí, así que
      // applyConfigOnce()/applyConfig() (usadas por el botón "Aplicar" de
      // auto-config) nunca se enteraban de que CMD_SET_CONFIG había fallado
      // — el catch del llamador jamás se ejecutaba, y la app mostraba
      // "Configuración aplicada correctamente" aunque el umbral, la
      // histéresis, el modo, la fuente de disparo o los retardos (los
      // parámetros que deciden CUÁNDO pulverizar) nunca hubieran llegado al
      // Arduino. Relanzar aquí dejando que cada llamador decida: el
      // auto-guardado con debounce (scheduleConfigSend) ya envuelve su
      // llamada en `.catch(() => {})` — sigue siendo "mejor esfuerzo" en
      // segundo plano — pero applyConfigOnce()/applyConfig() (el botón
      // explícito) ahora sí ven el fallo y pueden avisar de verdad.
      throw e;
    } finally {
      this.cfgInFlight = false;
      this.transport.pauseHeartbeat = false;
      if (this.cfgDirty) this.flushConfig().catch(() => {});
    }
  }

  // ================================================================
  // 🌐 API PÚBLICA
  // ================================================================
  // Tráfico de fondo: prioridad 'low' — nunca deben bloquear una acción del
  // usuario que llegue mientras están en cola (ver nota junto a cmdQueue en
  // BleTransportService).
  requestStatus()      { return this.sendCmd(this.CMD_GET_STATUS, undefined, 3000, 'low'); }
  requestRelayStats()  { return this.sendCmd(this.CMD_GET_RELAYSTAT, undefined, 3000, 'low'); }
  ping()               { return this.sendCmd(CMD_PING, undefined, 3000, 'low'); }

  /**
   * v15: `side` opcional — sin indicarlo, reinicia los dos lados a la vez
   * (comportamiento de siempre, payload vacío). Con 'L' o 'R', reinicia
   * solo ese lado (payload de 1 byte con el carácter del lado) — requiere
   * firmware v15+; en un firmware anterior el comando se rechazaría con
   * BAD_VALUE al no reconocer el payload de 1 byte.
   */
  async resetRelayStats(side?: 'L' | 'R'): Promise<void> {
    const pl = side ? new Uint8Array([side.charCodeAt(0)]) : undefined;
    await this.sendCmd(this.CMD_RESET_RELAYSTAT, pl);
    this.zone.run(() => {
      if (!side || side === 'L') { this.relayLeftTimeMs$.next(0);  this.relayLeftActivations$.next(0); }
      if (!side || side === 'R') { this.relayRightTimeMs$.next(0); this.relayRightActivations$.next(0); }
      this.relayStats$.next({
        L: { timeMs: this.relayLeftTimeMs$.value,  activations: this.relayLeftActivations$.value },
        R: { timeMs: this.relayRightTimeMs$.value, activations: this.relayRightActivations$.value },
      });
    });
  }

  /**
   * Calibra CONJUNTAMENTE el cero del sensor de nivel y el plano del MPU6050
   * (CMD_CALIBRATE_LEVEL, 0x09 — el ÚNICO comando de calibración de nivel que
   * existe en el firmware). Requiere: depósito vacío, equipo inmóvil, y
   * colocado en la orientación que se quiera considerar "plana" (no tiene por
   * qué ser terreno nivelado real — el firmware guarda cualquier orientación
   * en la que se calibre como referencia de cero).
   */
  async calibrateLevel(): Promise<void> {
    await this.sendCmd(this.CMD_CALIBRATE_LEVEL, undefined, 3000);

    this.zone.run(() => {
      this.levelCalibrated$.next(true);
      // Actualización inmediata del visor mientras llega el próximo EVT_LEVEL
      this.levelPressurePsi$.next(0);
      this.levelMm$.next(0);
      this.levelPercent$.next(0);
    });

    // Refresco posterior, pero sin bloquear la calibración
    void this.requestStatus().catch(error => {
      this.log('warn', 'CALIBRATION', 'No se pudo refrescar el estado tras calibrar', error);
    });
  }

  /**
   * @deprecated Alias de compatibilidad con nombres usados en versiones
   * anteriores de la app. Llama a calibrateLevel().
   */
  async calibrateEmpty(): Promise<void> {
    await this.calibrateLevel();
  }

  /**
   * @deprecated Alias de compatibilidad. El firmware v8 NO tiene sensor de
   * flujo: este opcode (0x09) ahora calibra el cero del sensor de NIVEL.
   * Usa calibrateLevel() directamente y actualiza la UI/textos que llamaban
   * a "resetFlow" — este método ya NO reinicia ningún contador de caudal.
   */
  async resetFlow(): Promise<void> {
    console.warn(
      '[BT] resetFlow() está deprecado: el firmware v8 no tiene sensor de flujo. ' +
      'Esta llamada en realidad ejecuta calibrateLevel() (calibra el cero del ' +
      'sensor de nivel, asumiendo depósito vacío). Migra el código a calibrateLevel().'
    );
    await this.calibrateLevel();
  }

  /**
   * v8: configura los umbrales de seguridad de alta presión en el Arduino
   * (CMD_SET_HIGH_PRESSURE_CONFIG, 0x0A) y los persiste en su EEPROM.
   * Debe cumplirse: 0 <= resetBar < alarmBar < hardLimitBar <= 60 bar
   * (v15: antes 20 — 60 bar es el fondo de escala físico del sensor,
   * HIGH_PRESSURE_MAX_BAR en el firmware; ajustar aquí si el sensor real
   * tiene otro rango).
   */
  async setHighPressureConfig(alarmBar: number, resetBar: number, hardLimitBar: number): Promise<void> {
    const SENSOR_MAX_BAR = 60; // debe coincidir con HIGH_PRESSURE_MAX_BAR del firmware
    // v8: se exige un margen mínimo real (HP_MIN_GAP_BAR) entre los tres
    // umbrales, no solo una desigualdad estricta matemática — antes,
    // resetBar=15.999 y alarmBar=16.0 pasaban la validación pese a no tener
    // ningún margen práctico de histéresis.
    if (!(resetBar >= 0 &&
          (alarmBar - resetBar) >= HP_MIN_GAP_BAR &&
          (hardLimitBar - alarmBar) >= HP_MIN_GAP_BAR &&
          hardLimitBar <= SENSOR_MAX_BAR)) {
      throw new Error(
        `BAD_VALUE: debe cumplirse 0 <= reset, (alarm-reset) >= ${HP_MIN_GAP_BAR}, ` +
        `(hardLimit-alarm) >= ${HP_MIN_GAP_BAR}, hardLimit <= ${SENSOR_MAX_BAR} bar`
      );
    }

    const alarmX100     = Math.round(alarmBar * 100);
    const resetX100     = Math.round(resetBar * 100);
    const hardLimitX100 = Math.round(hardLimitBar * 100);

    const pl = new Uint8Array(6);
    pl[0] = alarmX100 & 0xFF;     pl[1] = (alarmX100 >> 8) & 0xFF;
    pl[2] = resetX100 & 0xFF;     pl[3] = (resetX100 >> 8) & 0xFF;
    pl[4] = hardLimitX100 & 0xFF; pl[5] = (hardLimitX100 >> 8) & 0xFF;

    await this.sendCmd(this.CMD_SET_HIGH_PRESSURE_CONFIG, pl, 3000);

    this.zone.run(() => {
      this.highPressureAlarmBar$.next(alarmBar);
      this.highPressureResetBar$.next(resetBar);
      this.highPressureHardLimitBar$.next(hardLimitBar);
    });

    // v8: persistir de inmediato (antes no se guardaba en ningún sitio, y se
    // perdía al reiniciar la app pese a que el Arduino sí lo recordaba en su
    // propia EEPROM).
    await this.saveConfigToPreferences().catch(e =>
      this.log('warn', 'CONFIG', 'No se pudo persistir la config de alta presión', e)
    );
  }

  /**
   * v14: paso 1 de la calibración del sensor de ALTA presión (línea/bomba,
   * CMD_CALIBRATE_HIGH_PRESSURE_ZERO, 0x0F). Requiere el sensor a presión
   * atmosférica (sin ninguna presión aplicada) en el momento de calibrar.
   * Invalida en el firmware cualquier referencia (span) calibrada antes,
   * porque ya no sería coherente con este cero nuevo — hay que recalibrar
   * también el paso 2 tras esto.
   */
  async calibrateHighPressureZero(): Promise<void> {
    await this.sendCmd(this.CMD_CALIBRATE_HIGH_PRESSURE_ZERO, undefined, 3000);
    this.zone.run(() => {
      this.highPressureZeroCalibrated$.next(true);
      this.highPressureRefCalibrated$.next(false);
    });
  }

  /**
   * v14: paso 2 (CMD_CALIBRATE_HIGH_PRESSURE_REF, 0x19). Se manda con una
   * presión de referencia REAL aplicada en ese momento (bomba de mano,
   * manómetro patrón, etc.) — `refBar` es el valor de esa presión conocida,
   * lo aporta el usuario, el firmware no lo puede medir por su cuenta.
   * Requiere haber calibrado antes el cero (paso 1).
   */
  async calibrateHighPressureRef(refBar: number): Promise<void> {
    if (!(refBar > 0 && refBar <= 60)) {
      throw new Error('BAD_VALUE: la presión de referencia debe estar entre 0 y 60 bar');
    }
    const refBarX100 = Math.round(refBar * 100);
    const pl = new Uint8Array(2);
    pl[0] = refBarX100 & 0xFF;
    pl[1] = (refBarX100 >> 8) & 0xFF;

    await this.sendCmd(this.CMD_CALIBRATE_HIGH_PRESSURE_REF, pl, 3000);
    this.zone.run(() => this.highPressureRefCalibrated$.next(true));
  }

  /**
   * v11: calibra el punto "LLENO" del sensor de nivel (CMD_CALIBRATE_LEVEL_
   * FULL, 0x0B). Requiere haber calibrado antes el vacío con calibrateLevel()
   * — el firmware lo exige y devuelve BAD_VALUE si no hay una lectura de
   * referencia coherente. A diferencia del vacío, no fija ningún plano del
   * MPU6050: solo guarda la presión medida con el depósito realmente lleno.
   * En cuanto existen ambos puntos, el firmware pasa a calcular el nivel por
   * interpolación de presiones en vez de asumir la densidad del líquido.
   */
  async calibrateLevelFull(): Promise<void> {
    await this.sendCmd(this.CMD_CALIBRATE_LEVEL_FULL, undefined, 3000);

    this.zone.run(() => {
      this.levelFullCalibrated$.next(true);
    });

    void this.requestStatus().catch(error => {
      this.log('warn', 'CALIBRATION', 'No se pudo refrescar el estado tras calibrar lleno', error);
    });
  }

  /**
   * v11: configura la geometría del depósito en el Arduino (CMD_SET_TANK_
   * GEOMETRY, 0x0C) y la persiste en su EEPROM. Junto con la calibración de
   * 2 puntos (vacío/lleno), estos dos valores son los que el firmware usa
   * para calcular el nivel compensado por inclinación — ver nota v11 en el
   * .ino. Límites de cordura física: 100-5000 mm de altura, ±5000 mm de
   * posición del sensor (deben coincidir con los que valida el firmware).
   */
  async setTankGeometry(tankHeightMm: number, sensorLongitudinalOffsetMm: number): Promise<void> {
    const heightMm = Math.round(tankHeightMm);
    const offsetMm = Math.round(sensorLongitudinalOffsetMm);

    if (!(heightMm >= 100 && heightMm <= 5000)) {
      throw new Error('BAD_VALUE: la altura del depósito debe estar entre 100 y 5000 mm');
    }
    if (!(offsetMm >= -5000 && offsetMm <= 5000)) {
      throw new Error('BAD_VALUE: la posición del sensor debe estar entre -5000 y 5000 mm');
    }

    const pl = new Uint8Array(4);
    pl[0] = heightMm & 0xFF;
    pl[1] = (heightMm >> 8) & 0xFF;
    // i16 little-endian con signo: el rango validado (±5000) cabe sobrado en
    // 16 bits, y el patrón de bits de un negativo en JS (>>> / & 0xFF) ya
    // coincide con complemento a dos, igual que en el firmware.
    pl[2] = offsetMm & 0xFF;
    pl[3] = (offsetMm >> 8) & 0xFF;

    await this.sendCmd(this.CMD_SET_TANK_GEOMETRY, pl, 3000);

    this.zone.run(() => {
      this.tankHeightMm$.next(heightMm);
      this.sensorLongitudinalOffsetMm$.next(offsetMm);
    });

    await this.saveConfigToPreferences().catch(e =>
      this.log('warn', 'CONFIG', 'No se pudo persistir la geometría del depósito', e)
    );
  }

  /**
   * v13: true entre calibrateTiltReference() y calibrateTiltApply() — solo
   * para que la UI sepa en qué paso está (p.ej. mostrar "ahora inclina el
   * equipo y pulsa Calcular"). Es un espejo optimista del flag equivalente
   * en el firmware (tiltCalRefCaptured); no hay forma de leer ese flag del
   * Arduino directamente, así que si la app se reinicia a mitad del
   * procedimiento este flag vuelve a false aunque el firmware siga
   * recordando la referencia — sin problema real, el firmware la sigue
   * aceptando, solo que la UI pediría repetir el paso 1 innecesariamente.
   */
  public tiltCalRefCaptured$ = new BehaviorSubject<boolean>(false);

  /**
   * v13: paso 1 de la autocalibración de sensorLongitudinalOffsetMm por
   * inclinación (CMD_CALIBRATE_TILT_REF, 0x0D). Requiere: calibración de
   * vacío+lleno ya hecha (el firmware necesita el gradiente presión/mm para
   * el paso 2) y equipo nivelado y quieto — el firmware rechaza con
   * BAD_VALUE si el MPU no está estable. El nivel de llenado en este
   * momento da igual (cualquiera vale), pero NO debe cambiar hasta terminar
   * el paso 2 — la resta de las dos lecturas asume el mismo volumen.
   */
  async calibrateTiltReference(): Promise<void> {
    await this.sendCmd(this.CMD_CALIBRATE_TILT_REF, undefined, 3000);
    this.zone.run(() => this.tiltCalRefCaptured$.next(true));
  }

  /**
   * v13: paso 2 (CMD_CALIBRATE_TILT_APPLY, 0x0E). Se manda tras inclinar el
   * equipo una cantidad cualquiera respecto a la postura del paso 1 (el
   * ángulo lo mide el MPU, no se manda por protocolo) y sin haber cambiado
   * el volumen de líquido entre medias. El firmware calcula la distancia
   * del sensor al eje de basculamiento y la persiste en su EEPROM como
   * sensorLongitudinalOffsetMm — el valor resultante llega de vuelta en el
   * siguiente EVT_STATUS/EVT_SNAPSHOT (ver decodeLevelStatusExtension), por
   * eso aquí se refresca con requestStatus() en vez de fiarse de un valor
   * calculado también en el cliente (evita que difieran app/firmware por
   * redondeos).
   */
  async calibrateTiltApply(): Promise<void> {
    // Nota: si esto lanza (p.ej. BAD_VALUE por inclinación insuficiente
    // respecto al paso 1), el firmware CONSERVA la referencia y permite
    // reintentar el paso 2 con más inclinación sin repetir el paso 1 — así
    // que tiltCalRefCaptured$ debe seguir en `true` en ese caso; solo se
    // pone a `false` tras un éxito real, dejando que el catch del llamador
    // (la UI) decida qué mensaje mostrar sin perder el progreso del paso 1.
    await this.sendCmd(this.CMD_CALIBRATE_TILT_APPLY, undefined, 3000);
    this.zone.run(() => this.tiltCalRefCaptured$.next(false));
    await this.requestStatus().catch(error => {
      this.log('warn', 'CALIBRATION', 'No se pudo refrescar el estado tras calibrar inclinación', error);
    });
  }

  applyConfig(): Promise<void> {
    this.cfgDirty = true;
    if (this.cfgTimer) clearTimeout(this.cfgTimer);
    return this.flushConfig();
  }

  async applyConfigOnce(cfg: {
    sourceMode: 0|1; mode: 0|1;
    thresholdCm: number; hysteresisCm: number;
    retardoEntradaDist: number; retardoSalidaDist: number;
    retardoEntradaTemp: number; activeTimeModo1: number;
  }): Promise<void> {
    if (this.cfgTimer) { clearTimeout(this.cfgTimer); this.cfgTimer = null; }

    // Fix: instantánea de los valores ANTERIORES, para poder revertir si
    // flushConfig() falla (ahora que sí propaga el error — ver nota junto a
    // flushConfig). Sin esto, otras pantallas ligadas reactivamente a estos
    // mismos BehaviorSubjects (p.ej. el subtítulo del encabezado de
    // distance-view, que muestra sourceMode$/mode$ en directo) se quedarían
    // mostrando un modo/fuente que la app "cree" aplicado pero que el
    // Arduino nunca llegó a recibir.
    const previous = this.snapshotConfig();

    // Actualizar BehaviorSubjects con los nuevos valores (optimista)
    this.zone.run(() => {
      this.sourceMode$.next(cfg.sourceMode);
      this.mode$.next(cfg.mode);
      this.thresholdCm$.next(Math.round(cfg.thresholdCm));
      this.hysteresisCm$.next(Math.round(cfg.hysteresisCm));
      this.retardoEntradaDist$.next(Math.round(cfg.retardoEntradaDist));
      this.retardoSalidaDist$.next(Math.round(cfg.retardoSalidaDist));
      this.retardoEntradaTemp$.next(Math.round(cfg.retardoEntradaTemp));
      this.activeTimeModo1$.next(Math.round(cfg.activeTimeModo1));
    });
    // cfgDirty = true DESPUÉS de actualizar los valores
    this.cfgDirty = true;

    try {
      await this.flushConfig();
    } catch (error) {
      this.zone.run(() => {
        this.sourceMode$.next(previous.sourceMode);
        this.mode$.next(previous.mode);
        this.thresholdCm$.next(previous.thresholdCm);
        this.hysteresisCm$.next(previous.hysteresisCm);
        this.retardoEntradaDist$.next(previous.retardoEntradaDist);
        this.retardoSalidaDist$.next(previous.retardoSalidaDist);
        this.retardoEntradaTemp$.next(previous.retardoEntradaTemp);
        this.activeTimeModo1$.next(previous.activeTimeModo1);
      });
      throw error;
    }
  }

  setSourceMode(v: 0|1)    { this.sourceMode$.next(v);                                          this.scheduleConfigSend(); }
  setThresholdCm(v: number) { this.thresholdCm$.next(Math.max(5, Math.min(300, Math.round(v)))); this.scheduleConfigSend(); }
  setHysteresisCm(v: number){ this.hysteresisCm$.next(Math.max(0, Math.min(100, Math.round(v)))); this.scheduleConfigSend(); }
  setRetardoEntradaDist(v: number) { this.retardoEntradaDist$.next(Math.max(0, Math.min(60000, Math.round(v)))); this.scheduleConfigSend(); }
  setRetardoSalidaDist(v: number)  { this.retardoSalidaDist$.next(Math.max(0,  Math.min(60000, Math.round(v)))); this.scheduleConfigSend(); }
  setMode(v: 0|1)           { this.mode$.next(v);                                               this.scheduleConfigSend(); }
  setRetardoEntradaTemp(v: number) { this.retardoEntradaTemp$.next(Math.max(0, Math.min(60000, Math.round(v)))); this.scheduleConfigSend(); }
  setActiveTimeModo1(v: number)    { this.activeTimeModo1$.next(Math.max(0, Math.min(600000, Math.round(v))));   this.scheduleConfigSend(); }

  async setSideEnabled(side: 'L' | 'R', enabled: boolean): Promise<void> {
    this.log('info', 'ENABLE', `setSideEnabled ${side}=${enabled} (connected=${this.isConnected$.value})`);

    if (side === 'L') this.enabledLeft$.next(enabled);
    if (side === 'R') this.enabledRight$.next(enabled);

    if (!this.isConnected$.value) {
      // Sin conexión no hay nada que confirmar: se persiste ya (es la única
      // fuente de la intención del usuario) y connect() se encargará de
      // llevarla al Arduino en cuanto haya enlace — ver nota en connect().
      await this.saveConfigToPreferences().catch(() => {});
      this.log('info', 'ENABLE', `Sin conexión BT — guardado en Preferences, se enviará al conectar`);
      return;
    }

    const pl = new Uint8Array(2);
    pl[0] = side.charCodeAt(0) & 0xFF;
    pl[1] = enabled ? 1 : 0;

    try {
      // Fix latencia percibida (2ª vuelta): con 2 intentos (1.5s+2s) el peor
      // caso medido en el enlace real seguía en ~5s — mejor que los ~11s
      // originales, pero no se siente "inmediato" para un interruptor.
      // Comprobado en el enlace real de esta sesión: cuando un intento
      // falla, el reintento CASI NUNCA rescata nada (el enlace no está
      // perdiendo un frame suelto, está genuinamente sordo un rato) — así
      // que ese 2º intento solo añadía ~2s de espera sin mejorar la tasa de
      // éxito real. Un solo intento a 1.8s da el peor caso más bajo posible
      // sin volver a caer en el problema ya visto con timeouts <1.5s
      // (falsos timeouts en un enlace sano-pero-no-instantáneo). Si falla,
      // el usuario vuelve a tocar el interruptor — más barato y se siente
      // más responsivo que la app reintentando en silencio.
      await this.sendCmd(this.CMD_SET_ENABLE, pl, 1800, 'high', 1);
      this.log('info', 'ENABLE', `CMD_SET_ENABLE ${side}=${enabled} — ACK OK`);
      // Fix: antes se guardaba en Preferences el valor optimista ANTES de
      // saber si el Arduino lo aplicó, y nunca se corregía si el comando
      // fallaba después (el llamador revierte enabledLeft$/enabledRight$ EN
      // MEMORIA, pero el disco se quedaba con el valor equivocado para
      // siempre). Ahora solo se persiste tras la confirmación real — Preferences
      // nunca puede reflejar un cambio que el Arduino no aplicó de verdad.
      await this.saveConfigToPreferences().catch(() => {});
    } catch (error) {
      this.log('warn', 'ENABLE', `CMD_SET_ENABLE ${side}=${enabled} — ACK no recibido`, error);
      // No absorber el fallo: el llamador (onToggleLeft/onToggleRight) necesita
      // el rechazo para revertir el valor optimista de enabledLeft$/enabledRight$.
      // Si se traga aquí, el toggle se queda mostrando el valor tocado por el
      // usuario aunque el Arduino nunca haya aplicado el cambio.
      throw error;
    }
  }

  setLitersPerMin(v: number)    { this.litersPerMin$.next(Math.max(0, v)); }
  setNumApplicators(v: number)  { this.numApplicators$.next(Math.max(1, Math.round(v))); }
  setGrPerSec(v: number)        { this.grPerSec$.next(Math.max(0, Math.round(v))); }

  async testTrigger(side: 'L' | 'R'): Promise<void> {
    const pl = new Uint8Array(1);
    pl[0] = side.charCodeAt(0) & 0xFF;
    await this.sendCmd(this.CMD_TEST_TRIGGER, pl, 3000);
  }

  async emergencyStop(): Promise<void> {
    await this.sendCmd(this.CMD_EMERGENCY_STOP, undefined, 3000);
    this.zone.run(() => { this.relayLeft$.next(false); this.relayRight$.next(false); });
  }
}
