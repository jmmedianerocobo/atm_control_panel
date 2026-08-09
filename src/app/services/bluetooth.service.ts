import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Preferences } from '@capacitor/preferences';

declare var bluetoothSerial: any;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry {
  ts:       Date;
  level:    LogLevel;
  category: string;
  msg:      string;
  data?:    any;
}

export interface BluetoothDevice {
  name: string;
  address: string;
  id?: string;
}

interface PendingCommand {
  resolve: () => void;
  reject: (e: any) => void;
  cmdType: number;
  seq: number;
  timer: any;
}

// 'high' = acción disparada por el usuario (o algo que debe sentirse
// inmediato); 'low' = tráfico de fondo (sondeo periódico, heartbeat) que
// puede ceder el turno y no merece reintentos agresivos.
type CmdPriority = 'high' | 'low';

interface QueuedCmd {
  cmdType: number;
  payload?: Uint8Array;
  timeoutMs: number;
  priority: CmdPriority;
  resolve: () => void;
  reject: (e: any) => void;
}

// NOTA DE COMPATIBILIDAD (firmware v8):
// Los nombres "Relay"/"relé" se conservan porque el PROTOCOLO BINARIO sigue
// usando esos opcodes (EVT_RELAY 0x12, EVT_RELAYSTAT 0x15, etc). El hardware
// real ya NO usa relés electromecánicos, son salidas MOSFET. No es necesario
// cambiar esto: es solo una etiqueta heredada del protocolo, no afecta a nada.

// v8: separación mínima obligatoria entre los tres umbrales de alta presión
// (reset/alarm/hardLimit). Exportada para que cualquier UI que valide estos
// mismos umbrales (steppers, formularios) use exactamente el mismo valor y
// nunca puedan desincronizarse si algún día cambia.
export const HP_MIN_GAP_BAR = 0.1;

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

@Injectable({ providedIn: 'root' })
export class BluetoothService {

  // ================================================================
  // 🔵 ESTADOS PÚBLICOS
  // ================================================================
  public isConnected$ = new BehaviorSubject<boolean>(false);
  // Fix: antes el nombre/dirección del dispositivo conectado solo vivía en
  // bt-settings.page.ts (campos locales del componente). Si esa página se
  // recreaba (navegar fuera y volver — Angular destruye/recrea el
  // componente), esos campos se reseteaban a '' aunque la conexión real
  // (aquí, en el servicio singleton, que SÍ sobrevive a la navegación)
  // siguiera viva: la lista de emparejados dejaba de marcar cuál era el
  // activo y el subtítulo perdía el nombre. Ahora la identidad del
  // dispositivo conectado vive aquí, donde de verdad pertenece.
  public connectedDevice$ = new BehaviorSubject<BluetoothDevice | null>(null);

  public pairedDevices$   = new BehaviorSubject<BluetoothDevice[]>([]);
  public unpairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);

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

  // El firmware v8 anuncia PROTOCOL_VERSION = 4 en EVT_BOOT. Se inicializa
  // aquí directamente en 4 para evitar un estado transitorio incorrecto
  // durante el primer instante tras conectar (antes de recibir EVT_BOOT).
  public arduinoProtocolVersion$ = new BehaviorSubject<number>(4);

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
  // 🧩 PROTOCOLO (adaptado a firmware v8/v9/v10)
  // ================================================================
  private readonly SOF1     = 0xAA;
  private readonly SOF2     = 0x55;
  private readonly VER      = 0x01;
  private readonly ACK_BASE = 0x80;

  private readonly CMD_PING            = 0x01;
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

  private readonly EVT_BOOT      = 0x10;
  private readonly EVT_DIST      = 0x11;
  private readonly EVT_RELAY     = 0x12;
  private readonly EVT_SNAPSHOT  = 0x13;
  private readonly EVT_STATUS    = 0x14;
  private readonly EVT_RELAYSTAT = 0x15;
  private readonly EVT_KEEPALIVE = 0x16;
  // v8: 0x17 YA NO es "flujo". Ahora es el nivel de atomizado (presión de
  // baja + compensación por inclinación).
  private readonly EVT_LEVEL         = 0x17;
  // v8: nuevo opcode, presión de línea/bomba + estado de bloqueo de seguridad.
  private readonly EVT_HIGH_PRESSURE = 0x18;

  private readonly RES_OK       = 0;
  private readonly RES_BAD_LEN  = 1;
  private readonly RES_BAD_VAL  = 2;
  private readonly RES_BAD_SIDE = 3;
  private readonly RES_CRC_ERR  = 4;

  // ================================================================
  // 🧱 INTERNOS
  // ================================================================
  private device: BluetoothDevice | null = null;
  private seqTx = 1;
  private queue: PendingCommand[] = [];
  // Cola de comandos con prioridad (fluidez): 'high' = acción del usuario
  // (tocar un interruptor, aplicar config, calibrar, parada de emergencia...),
  // 'low' = tráfico de fondo (sondeo periódico de estado/estadísticas, PING).
  // Antes esto era una única cadena de promesas (cmdChain) estrictamente FIFO:
  // un sondeo de fondo en curso (con sus reintentos de hasta ~9.7s en el peor
  // caso) bloqueaba igual que si fuera crítico cualquier acción del usuario
  // que llegara mientras tanto, aunque fuera trivial. Con la cola con
  // prioridad, una acción 'high' se cuela delante de cualquier 'low' que
  // todavía no haya empezado a transmitirse (no se puede abortar un envío ya
  // en curso, pero con FAST_RETRY_TIMEOUT_MS ese envío en curso como mucho
  // bloquea unos cientos de ms, no segundos).
  private cmdQueue: QueuedCmd[] = [];
  private cmdWorkerActive = false;
  private readonly MAX_LEN = 64;

  private cfgTimer: any = null;
  private cfgInFlight = false;
  private cfgDirty    = false;

  // ================================================================
  // 📋 SISTEMA DE LOG
  // ================================================================
  public logEnabled = true;  // activar/desactivar desde consola: bt.logEnabled = false
  public logEntries$ = new BehaviorSubject<LogEntry[]>([]);
  private readonly MAX_LOG_ENTRIES = 200;

  private log(level: LogLevel, category: string, msg: string, data?: any) {
    if (!this.logEnabled) return;
    const entry: LogEntry = {
      ts:       new Date(),
      level,
      category,
      msg,
      data,
    };
    const current = this.logEntries$.value;
    const updated = [entry, ...current].slice(0, this.MAX_LOG_ENTRIES);
    this.logEntries$.next(updated);

    const prefix = `[BT][${category}]`;
    switch (level) {
      case 'error': console.error(prefix, msg, data ?? ''); break;
      case 'warn':  console.warn(prefix,  msg, data ?? ''); break;
      case 'info':  console.info(prefix,  msg, data ?? ''); break;
      case 'debug': console.debug(prefix, msg, data ?? ''); break;
    }
  }

  public clearLog() { this.logEntries$.next([]); }
  private readonly CFG_DEBOUNCE_MS = 300;

  private heartbeatTimer: any = null;
  private readonly HEARTBEAT_INTERVAL_MS = 15000;
  private heartbeatFailCount = 0;
  // Nº de PING consecutivos fallidos antes de forzar una reconexión. Con 1
  // solo fallo reconectaríamos por cualquier trama perdida puntual (ruido
  // normal del enlace); con 3 (45s de silencio total) distinguimos ruido
  // de un enlace genuinamente muerto/"fantasma".
  private readonly HEARTBEAT_FAIL_THRESHOLD = 3;

  private reconnecting = false;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private reconnectAttempts = 0;

  // v8: valor inicial 4 (antes 3), coherente con arduinoProtocolVersion$ arriba.
  private arduinoProtocolVersion = 4;

  // ================================================================
  // 📩 RX
  // ================================================================
  private rxState: 'SOF1'|'SOF2'|'VER'|'TYPE'|'SEQ0'|'SEQ1'|'LEN0'|'LEN1'|'PAYLOAD'|'CRC0'|'CRC1' = 'SOF1';
  private rxType = 0;
  private rxSeq  = 0;
  private rxLen  = 0;
  private rxPayload = new Uint8Array(512);
  private rxOff  = 0;
  private rxCrc  = 0;

  constructor(private zone: NgZone) {
    this.loadConfigFromPreferences().catch(err =>
      console.error('Error cargando config inicial:', err)
    );
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
        // que setHighPressureConfig() (reset < alarm < hardLimit <= 20 bar).
        // Si lo guardado no es coherente (versión antigua, dato corrupto),
        // se ignoran los tres y se mantienen los valores por defecto.
        if (hpAlarm.value && hpReset.value && hpHard.value) {
          const a = Number(hpAlarm.value);
          const r = Number(hpReset.value);
          const h = Number(hpHard.value);
          if (r >= 0 && (a - r) >= HP_MIN_GAP_BAR && (h - a) >= HP_MIN_GAP_BAR && h <= 20) {
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
  // 🔎 ESCANEO / CONEXIÓN
  // ================================================================
  async listPairedDevices(): Promise<BluetoothDevice[]> {
    return new Promise((resolve, reject) => {
      bluetoothSerial.list(
        (devs: any[]) => resolve((devs || []).map(d => ({
          name: d.name || d.id || 'BT',
          address: d.address || d.id,
          id: d.id || d.address || d.name,
        }))),
        (e: any) => reject(e)
      );
    });
  }

  async loadPairedDevices(): Promise<void> {
    const devs = await this.listPairedDevices();
    this.zone.run(() => this.pairedDevices$.next(devs));
  }

  async scanForUnpaired(): Promise<void> {
    return new Promise((resolve, reject) => {
      const fn = bluetoothSerial?.discoverUnpaired;
      if (typeof fn !== 'function') { reject(new Error('discoverUnpaired not supported')); return; }
      bluetoothSerial.discoverUnpaired(
        (devs: any[]) => {
          const mapped: BluetoothDevice[] = (devs || []).map((d: any) => ({
            name: d.name || d.id || 'BT',
            address: d.address || d.id,
            id: d.id || d.address || d.name,
          }));
          this.zone.run(() => this.unpairedDevices$.next(mapped));
          resolve();
        },
        (e: any) => reject(e)
      );
    });
  }

  async connect(deviceOrAddress: BluetoothDevice | string): Promise<void> {
    const address = typeof deviceOrAddress === 'string' ? deviceOrAddress : deviceOrAddress.address;
    this.device   = typeof deviceOrAddress === 'string' ? { name: address, address } : deviceOrAddress;
    this.log('info', 'CONNECT', `Conectando a ${this.device.name} (${address})`);

    try { bluetoothSerial.unsubscribeRawData(() => {}, () => {}); } catch {}
    try { bluetoothSerial.unsubscribe(() => {}, () => {}); } catch {}

    await new Promise<void>((resolve, reject) => {
      bluetoothSerial.connect(address, () => resolve(), (e: any) => reject(e));
    });

    this.log('info', 'CONNECT', `Conexión BT establecida con ${this.device.name}`);
    this.zone.run(() => {
      this.isConnected$.next(true);
      this.connectedDevice$.next(this.device);
    });
    this.subscribeToIncomingRaw();

    await new Promise(r => setTimeout(r, 500));

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
    this.adaptToProtocolVersion();
    this.log('info', 'CONNECT', 'Conexión completada', { enableL: this.enabledLeft$.value, enableR: this.enabledRight$.value });
  }

  async disconnect(): Promise<void> {
    this.log('info', 'CONNECT', 'Desconectando...');
    this.stopHeartbeat();
    if (this.cfgTimer) { clearTimeout(this.cfgTimer); this.cfgTimer = null; }
    this.cfgDirty = false;
    this.cfgInFlight = false;

    this.queue.forEach(cmd => { clearTimeout(cmd.timer); cmd.reject('Disconnected'); });
    this.queue = [];
    // Comandos ya encolados pero que el worker aún no ha empezado a enviar:
    // rechazarlos ya mismo en vez de dejar que se intenten con el enlace
    // muerto (fallarían igualmente, solo que más tarde).
    this.cmdQueue.forEach(e => e.reject(new Error('Disconnected')));
    this.cmdQueue = [];
    this.resetRx();

    try { bluetoothSerial.unsubscribeRawData(() => {}, () => {}); } catch {}
    try { bluetoothSerial.unsubscribe(() => {}, () => {}); } catch {}

    await new Promise<void>((resolve) => {
      bluetoothSerial.disconnect(() => resolve(), () => resolve());
    });

    this.device = null;
    this.zone.run(() => {
      this.isConnected$.next(false);
      this.connectedDevice$.next(null);
    });
  }

  // ================================================================
  // HEARTBEAT / RECONNECT
  // ================================================================
  private adaptToProtocolVersion() {
    // Fix "conexión fantasma": antes esto desactivaba el heartbeat para
    // protocolo >=2 (este firmware siempre reporta v4), asumiendo que sus
    // eventos autónomos (EVT_LEVEL/EVT_DIST/...) bastaban para no necesitar
    // un ping explícito. Pero ninguno de esos eventos tiene enganchada
    // lógica de reconexión — reconnect() SOLO se dispara desde el fallo del
    // ping del heartbeat, en todo el código. Con el heartbeat desactivado,
    // si el socket Bluetooth nativo se queda "fantasma" (el write() del
    // móvil devuelve éxito pero nada llega realmente al otro lado — visto
    // en depuración real), la app no tenía NINGÚN mecanismo para darse
    // cuenta ni recuperarse: el chip seguía diciendo "Conectado" para
    // siempre y cada comando fallaba en silencio. El heartbeat debe estar
    // siempre activo mientras haya conexión, sea cual sea el protocolo.
    this.startHeartbeat();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatFailCount = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected$.value || this.cfgInFlight) return;
      this.ping().then(() => {
        this.heartbeatFailCount = 0;
      }).catch(() => {
        this.heartbeatFailCount++;
        this.log('warn', 'HEARTBEAT', `PING sin respuesta (${this.heartbeatFailCount}/${this.HEARTBEAT_FAIL_THRESHOLD})`);
        if (this.heartbeatFailCount >= this.HEARTBEAT_FAIL_THRESHOLD) {
          this.heartbeatFailCount = 0;
          this.log('warn', 'HEARTBEAT', 'Enlace considerado muerto — reconectando');
          this.reconnect().catch(() => {});
        }
      });
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || !this.device) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) return;

    this.reconnecting = true;
    this.reconnectAttempts++;

    try {
      const dev = this.device!;
      // No hace falta esperar aquí a que la cola de comandos se vacíe: en
      // cuanto disconnect() pone isConnected$ a false, cualquier comando en
      // curso o en cola falla de inmediato (ver sendCmdInternal/disconnect),
      // así que el worker se libera solo casi al instante.
      try { await this.disconnect(); } catch {}
      await new Promise(r => setTimeout(r, 800));
      try { await this.connect(dev); this.reconnectAttempts = 0; } catch {}
    } finally {
      this.reconnecting = false;
    }
  }

  // ================================================================
  // CRC16
  // ================================================================
  private crc16_ccitt(buf: Uint8Array): number {
    let crc = 0xFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= (buf[i] << 8) & 0xFFFF;
      for (let b = 0; b < 8; b++) {
        if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
        else crc = (crc << 1) & 0xFFFF;
      }
    }
    return crc & 0xFFFF;
  }

  // ================================================================
  // FRAME
  // ================================================================
  private buildFrame(type: number, seq: number, payload?: Uint8Array): Uint8Array {
    const len   = payload?.length ?? 0;
    const total = 2 + 1 + 1 + 2 + 2 + len + 2;
    const out   = new Uint8Array(total);
    let o = 0;

    out[o++] = this.SOF1;
    out[o++] = this.SOF2;
    out[o++] = this.VER;
    out[o++] = type & 0xFF;
    out[o++] = seq & 0xFF;
    out[o++] = (seq >> 8) & 0xFF;
    out[o++] = len & 0xFF;
    out[o++] = (len >> 8) & 0xFF;

    if (payload && len > 0) out.set(payload, o);
    o += len;

    const crc = this.crc16_ccitt(out.slice(2, 2 + 1 + 1 + 2 + 2 + len));
    out[o++] = crc & 0xFF;
    out[o++] = (crc >> 8) & 0xFF;

    return out;
  }

  private nextSeq(): number {
    const v = this.seqTx & 0xFFFF;
    this.seqTx = (this.seqTx + 1) & 0xFFFF;
    return v;
  }

  // Fix: bluetoothSerial.write() a veces no llama a NINGÚN callback (ni éxito
  // ni error) cuando el enlace BLE se queda colgado sin generar un evento de
  // desconexión formal. Como sendCmdInternal() hace `await writeBytes(...)`
  // antes de devolver la promesa que sí tiene timeout (la del ACK), un write
  // sin timeout se queda esperando para siempre — y como todos los comandos
  // se procesan uno a uno por el mismo worker (cmdQueue), ese único write
  // colgado bloquea TODA la cola de comandos para siempre, no solo el
  // actual. Desde la UI esto se ve
  // como el botón "Aplicar" quedándose en "Aplicando…" indefinidamente,
  // porque el finally que resetea `saving` nunca llega a ejecutarse. Con este
  // timeout, un write que no responde acaba rechazando y deja que
  // sendCmdWithRetry reintente o que el error se propague a la UI.
  private async writeBytes(bytes: Uint8Array, timeoutMs = 3000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('WRITE_TIMEOUT'));
      }, timeoutMs);

      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      bluetoothSerial.write(
        buf,
        () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); },
        (e: any) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
      );
    });
  }

  // ================================================================
  // SEND
  // ================================================================
  private async sendCmdInternal(cmdType: number, payload?: Uint8Array, timeoutMs = 3000): Promise<void> {
    if (!this.isConnected$.value) throw new Error('Not connected');
    const len = payload?.length ?? 0;
    if (len > this.MAX_LEN) throw new Error('BAD_LEN');

    const seq   = this.nextSeq();
    const frame = this.buildFrame(cmdType, seq, payload);

    const p = new Promise<void>((resolve, reject) => {
      const entry: PendingCommand = { resolve, reject, cmdType, seq, timer: null };
      entry.timer = setTimeout(() => {
        this.queue = this.queue.filter(x => x.seq !== seq);
        reject('ACK timeout');
      }, timeoutMs);
      this.queue.push(entry);
    });

    try {
      await this.writeBytes(frame);
    } catch (e) {
      // El write falló (o hizo timeout) antes de llegar a mandarse: retirar
      // la entrada pendiente ya insertada en la cola, para no dejarla
      // colgando hasta que su propio timer de ACK dispare más tarde.
      this.queue = this.queue.filter(x => x.seq !== seq);
      throw e;
    }
    return p;
  }

  // Timeout corto para los intentos "no definitivos". OJO: en el propio
  // cable/UART a 9600 baudios una trama de este protocolo tarda del orden
  // de decenas de ms, pero el round-trip REAL medido en este enlace
  // (stack Bluetooth clásico de Android + AltSoftSerial + tráfico
  // autónomo del firmware compitiendo por el aire) puede tardar bastante
  // más que eso — con 500ms se comprobó en la práctica que se daban por
  // perdidas respuestas que en realidad iban a llegar poco después,
  // convirtiendo el "camino rápido" en más reintentos y más fallos, no
  // menos. 1500ms sigue siendo muchísimo mejor que pagar el timeoutMs
  // completo (por defecto 3000-5000ms) en el primer intento como se hacía
  // antes, pero da margen real a la latencia de este enlace. Solo el
  // ÚLTIMO intento usa el timeoutMs pedido por el llamador, como red de
  // seguridad para el caso de que el Arduino esté genuinamente ocupado
  // (p.ej. en medio de un ping_cm() bloqueante) y no de que la trama se
  // haya perdido.
  private readonly FAST_RETRY_TIMEOUT_MS = 1500;

  private sendCmd(
    cmdType: number,
    payload?: Uint8Array,
    timeoutMs = 3000,
    priority: CmdPriority = 'high',
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Los comandos de fondo (sondeo periódico) son idempotentes: si ya hay
      // uno del mismo tipo esperando turno (todavía no enviado), no tiene
      // sentido apilar otro detrás — el que ya está en cola cubre lo mismo
      // y evita que la cola crezca sin límite si el enlace va lento.
      if (priority === 'low' && this.cmdQueue.some(e => e.priority === 'low' && e.cmdType === cmdType)) {
        resolve();
        return;
      }

      const entry: QueuedCmd = { cmdType, payload, timeoutMs, priority, resolve, reject };

      if (priority === 'high') {
        // Se cuela delante del primer comando de fondo pendiente (los 'high'
        // ya en cola mantienen su orden de llegada entre ellos).
        const idx = this.cmdQueue.findIndex(e => e.priority === 'low');
        if (idx === -1) this.cmdQueue.push(entry);
        else this.cmdQueue.splice(idx, 0, entry);
      } else {
        this.cmdQueue.push(entry);
      }

      void this.runCmdWorker();
    });
  }

  // Único "trabajador" que vacía la cola en orden de prioridad, uno a uno
  // (el enlace serie es de un solo comando en vuelo). Sustituye a la antigua
  // cadena `cmdChain` estrictamente FIFO — ver nota junto a `cmdQueue`.
  private async runCmdWorker(): Promise<void> {
    if (this.cmdWorkerActive) return;
    this.cmdWorkerActive = true;
    try {
      while (this.cmdQueue.length > 0) {
        const entry = this.cmdQueue.shift()!;
        // Los comandos de fondo no reintentan: si fallan, el propio sondeo
        // periódico volverá a pedirlo en el siguiente ciclo, y así un
        // comando de fondo bloquea la cola como mucho ~500ms en vez de
        // hasta ~9.7s con reintentos.
        const attempts = entry.priority === 'low' ? 1 : 3;
        try {
          await this.sendCmdWithRetry(entry.cmdType, entry.payload, entry.timeoutMs, attempts);
          entry.resolve();
        } catch (e) {
          entry.reject(e);
        }
      }
    } finally {
      this.cmdWorkerActive = false;
    }
  }

  private async sendCmdWithRetry(cmdType: number, payload: Uint8Array | undefined, timeoutMs: number, attempts: number): Promise<void> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      const isLastAttempt = i === attempts - 1;
      const attemptTimeout = isLastAttempt ? timeoutMs : Math.min(timeoutMs, this.FAST_RETRY_TIMEOUT_MS);
      try {
        await this.sendCmdInternal(cmdType, payload, attemptTimeout);
        return;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e);
        // WRITE_TIMEOUT (el write nativo no llamó a ningún callback a
        // tiempo) es tan transitorio como un ACK que no llega, así que
        // también se beneficia de reintento con el mismo backoff.
        const transient = msg.includes('ACK timeout') || msg.includes('WRITE_TIMEOUT');
        if (msg.includes('BAD_') || !transient) break;
        await new Promise(r => setTimeout(r, i === 0 ? 150 : 350));
      }
    }
    throw lastErr;
  }

  // ================================================================
  // RX
  // ================================================================
  private subscribeToIncomingRaw() {
    this.resetRx();
    bluetoothSerial.subscribeRawData(
      (data: any) => {
        let bytes: Uint8Array | null = null;
        if (data instanceof ArrayBuffer)          bytes = new Uint8Array(data);
        else if (data?.buffer instanceof ArrayBuffer) bytes = new Uint8Array(data.buffer);
        else if (Array.isArray(data))             bytes = new Uint8Array(data);
        else if (typeof data === 'string') {
          const arr = new Uint8Array(data.length);
          for (let i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i) & 0xFF;
          bytes = arr;
        }
        if (bytes) this.handleIncomingBytes(bytes);
      },
      (_err: any) => {}
    );
  }

  private resetRx() {
    this.rxState = 'SOF1'; this.rxType = 0; this.rxSeq = 0;
    this.rxLen = 0; this.rxOff = 0; this.rxCrc = 0;
  }

  private handleIncomingBytes(bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] & 0xFF;
      switch (this.rxState) {
        case 'SOF1':    if (b === this.SOF1) this.rxState = 'SOF2'; break;
        case 'SOF2':    if (b === this.SOF2) this.rxState = 'VER'; else this.rxState = (b === this.SOF1) ? 'SOF2' : 'SOF1'; break;
        case 'VER':     if (b !== this.VER) { this.resetRx(); break; } this.rxState = 'TYPE'; break;
        case 'TYPE':    this.rxType = b; this.rxState = 'SEQ0'; break;
        case 'SEQ0':    this.rxSeq = b; this.rxState = 'SEQ1'; break;
        case 'SEQ1':    this.rxSeq |= (b << 8); this.rxState = 'LEN0'; break;
        case 'LEN0':    this.rxLen = b; this.rxState = 'LEN1'; break;
        case 'LEN1':
          this.rxLen |= (b << 8);
          if (this.rxLen > this.MAX_LEN) { this.resetRx(); break; }
          this.rxOff = 0;
          this.rxState = (this.rxLen === 0) ? 'CRC0' : 'PAYLOAD';
          break;
        case 'PAYLOAD': this.rxPayload[this.rxOff++] = b; if (this.rxOff >= this.rxLen) this.rxState = 'CRC0'; break;
        case 'CRC0':    this.rxCrc = b; this.rxState = 'CRC1'; break;
        case 'CRC1': {
          this.rxCrc |= (b << 8);
          const tmp = new Uint8Array(1 + 1 + 2 + 2 + this.rxLen);
          let o = 0;
          tmp[o++] = this.VER; tmp[o++] = this.rxType & 0xFF;
          tmp[o++] = this.rxSeq & 0xFF; tmp[o++] = (this.rxSeq >> 8) & 0xFF;
          tmp[o++] = this.rxLen & 0xFF; tmp[o++] = (this.rxLen >> 8) & 0xFF;
          if (this.rxLen > 0) tmp.set(this.rxPayload.slice(0, this.rxLen), o);
          const calc = this.crc16_ccitt(tmp);
          if (calc === (this.rxCrc & 0xFFFF)) {
            this.dispatchFrame(this.rxType, this.rxSeq & 0xFFFF, this.rxPayload.slice(0, this.rxLen));
          }
          this.resetRx();
          break;
        }
      }
    }
  }

  // ================================================================
  // DISPATCH
  // ================================================================
  private u16LE(p: Uint8Array, o: number): number { return (p[o] | (p[o+1] << 8)) & 0xFFFF; }
  private u32LE(p: Uint8Array, o: number): number { return ((p[o]) | (p[o+1] << 8) | (p[o+2] << 16) | (p[o+3] << 24)) >>> 0; }

  private decodeAckError(code: number) {
    if (code === this.RES_BAD_LEN)  return 'BAD_LEN';
    if (code === this.RES_BAD_VAL)  return 'BAD_VALUE';
    if (code === this.RES_BAD_SIDE) return 'BAD_SIDE';
    if (code === this.RES_CRC_ERR)  return 'CRC_ERR';
    return `ERR_${code}`;
  }

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

    this.zone.run(() => {
      this.levelMm$.next(levelMm);
      this.levelPressurePsi$.next(pressurePsi);
      this.tiltDeg$.next(tiltDeg);
      this.levelValid$.next(valid);
      this.levelCalibrated$.next(zeroCalibrated);
      this.levelFullCalibrated$.next(fullCalibrated);
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

    this.zone.run(() => {
      this.highPressureBar$.next(bar);
      this.highPressureSensorFault$.next(sensorFault);
      this.highPressureLockout$.next(lockout);
    });

    return true;
  }

  // ================================================================
  // DISPATCH FRAMES
  // ================================================================
  private dispatchFrame(type: number, seq: number, payload: Uint8Array) {
    if ((type & this.ACK_BASE) === this.ACK_BASE) {
      const result = payload.length >= 1 ? payload[0] : 0xFF;
      const idx = this.queue.findIndex(x => x.seq === seq && type === (this.ACK_BASE | (x.cmdType & 0x7F)));
      if (idx !== -1) {
        const cur = this.queue[idx];
        clearTimeout(cur.timer);
        this.queue.splice(idx, 1);
        if (result === this.RES_OK) {
          this.log('debug', 'ACK', `ACK OK — cmd=0x${cur.cmdType.toString(16).padStart(2,'0')} seq=${seq}`);
          cur.resolve();
        } else {
          const errStr = this.decodeAckError(result);
          this.log('error', 'ACK', `ACK ERROR — cmd=0x${cur.cmdType.toString(16).padStart(2,'0')} seq=${seq} error=${errStr}`);
          cur.reject(errStr);
        }
      }
      return;
    }

    switch (type) {
      case this.EVT_BOOT:
        if (payload.length >= 1) {
          const version = payload[0];
          this.log('info', 'EVT', `EVT_BOOT — protocolo v${version}`);
          if (version !== this.arduinoProtocolVersion) {
            this.arduinoProtocolVersion = version;
            this.zone.run(() => this.arduinoProtocolVersion$.next(version));
            this.adaptToProtocolVersion();
          }
        }
        return;

      case this.EVT_DIST: {
        if (payload.length < 3) return;
        const side = String.fromCharCode(payload[0]);
        const cm   = this.u16LE(payload, 1);
        this.zone.run(() => {
          if (side === 'L') this.distanceLeft$.next(cm);
          if (side === 'R') this.distanceRight$.next(cm);
        });
        return;
      }

      case this.EVT_RELAY: {
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

      case this.EVT_SNAPSHOT: {
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

      case this.EVT_STATUS: {
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

      case this.EVT_RELAYSTAT: {
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
      case this.EVT_LEVEL:
        this.decodeLevelPayload(payload, 0);
        return;

      // v8: nuevo opcode, alta presión + estado de bloqueo de seguridad.
      case this.EVT_HIGH_PRESSURE:
        this.decodeHighPressurePayload(payload);
        return;

      case this.EVT_KEEPALIVE:
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
      if (this.cfgDirty) this.flushConfig().catch(() => {});
    }
  }

  // ================================================================
  // 🌐 API PÚBLICA
  // ================================================================
  // Tráfico de fondo: prioridad 'low' — nunca deben bloquear una acción del
  // usuario que llegue mientras están en cola (ver nota junto a cmdQueue).
  requestStatus()      { return this.sendCmd(this.CMD_GET_STATUS, undefined, 3000, 'low'); }
  requestRelayStats()  { return this.sendCmd(this.CMD_GET_RELAYSTAT, undefined, 3000, 'low'); }
  ping()               { return this.sendCmd(this.CMD_PING, undefined, 3000, 'low'); }

  async resetRelayStats(): Promise<void> {
    await this.sendCmd(this.CMD_RESET_RELAYSTAT);
    this.zone.run(() => {
      this.relayLeftTimeMs$.next(0);   this.relayLeftActivations$.next(0);
      this.relayRightTimeMs$.next(0);  this.relayRightActivations$.next(0);
      this.relayStats$.next({ L: { timeMs: 0, activations: 0 }, R: { timeMs: 0, activations: 0 } });
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
   * Debe cumplirse: 0 <= resetBar < alarmBar < hardLimitBar <= 20 bar
   * (20 bar es el fondo de escala físico del sensor, HIGH_PRESSURE_MAX_BAR
   * en el firmware; ajustar aquí si el sensor real tiene otro rango).
   */
  async setHighPressureConfig(alarmBar: number, resetBar: number, hardLimitBar: number): Promise<void> {
    const SENSOR_MAX_BAR = 20; // debe coincidir con HIGH_PRESSURE_MAX_BAR del firmware
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
      await this.sendCmd(this.CMD_SET_ENABLE, pl, 5000);
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