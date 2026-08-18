import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

declare var bluetoothSerial: any;

// ================================================================
// Extraído de bluetooth.service.ts al partir el servicio (sin cambiar
// comportamiento): esta clase es la capa de TRANSPORTE — framing/CRC del
// protocolo binario, cola de comandos con prioridad y reintentos, parser RX,
// conexión/desconexión del socket, heartbeat y emparejamiento. No conoce
// nada del DOMINIO del atomizador (nivel, presión, salidas...) — eso sigue
// en BluetoothService, que se queda como fachada fina inyectando esto y
// suscribiéndose a frame$ para decodificar los EVT_* que no gestiona el
// propio transporte (EVT_BOOT y EVT_KEEPALIVE sí se gestionan aquí, porque
// EVT_BOOT controla el heartbeat). La RECONEXIÓN completa (no solo el
// socket) tampoco vive aquí — ver reconnectRequested$ más abajo — porque
// necesita rehacer la sincronización de dominio tras reconectar, que es
// cosa de BluetoothService.
// ================================================================

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
export type CmdPriority = 'high' | 'low';

interface QueuedCmd {
  cmdType: number;
  payload?: Uint8Array;
  timeoutMs: number;
  priority: CmdPriority;
  // Nº de intentos a forzar para ESTE comando, si difiere del que le tocaría
  // por prioridad (ver runCmdWorker). Pensado para comandos 'high' donde el
  // usuario espera respuesta casi inmediata (p.ej. activar/desactivar un
  // lado): 3 intentos con el presupuesto normal de CMD_SET_ENABLE tardaban
  // hasta ~8.5s en fallar del todo — demasiado para algo que se siente como
  // un interruptor. Con esto se puede pedir menos intentos sin tocar el
  // comportamiento (más tolerante a reintentos) del resto de comandos 'high'.
  attempts?: number;
  resolve: () => void;
  reject: (e: any) => void;
}

/** Trama ya validada (CRC OK) que no es un ACK ni la gestiona el transporte
 *  internamente (EVT_BOOT/EVT_KEEPALIVE) — BluetoothService la decodifica. */
export interface RawFrame {
  type: number;
  seq: number;
  payload: Uint8Array;
}

// ================================================================
// 🧩 PROTOCOLO — constantes de framing/eventos compartidas con la fachada.
// CMD_PING se exporta porque el propio heartbeat del transporte lo manda
// internamente (el resto de CMD_* siguen viviendo solo en BluetoothService,
// que es quien construye cada payload de dominio). Los EVT_* se exportan
// porque BluetoothService los necesita para decodificar frame$.
// ================================================================
const SOF1     = 0xAA;
const SOF2     = 0x55;
const VER      = 0x01;
const ACK_BASE = 0x80;

export const CMD_PING = 0x01;

export const EVT_BOOT      = 0x10;
export const EVT_DIST      = 0x11;
export const EVT_RELAY     = 0x12;
export const EVT_SNAPSHOT  = 0x13;
export const EVT_STATUS    = 0x14;
export const EVT_RELAYSTAT = 0x15;
export const EVT_KEEPALIVE = 0x16;
export const EVT_LEVEL         = 0x17;
export const EVT_HIGH_PRESSURE = 0x18;

const RES_OK       = 0;
const RES_BAD_LEN  = 1;
const RES_BAD_VAL  = 2;
const RES_BAD_SIDE = 3;
const RES_CRC_ERR  = 4;

@Injectable({ providedIn: 'root' })
export class BleTransportService {

  // ================================================================
  // 🔵 ESTADO DE CONEXIÓN
  // ================================================================
  public isConnected$     = new BehaviorSubject<boolean>(false);
  public connectedDevice$ = new BehaviorSubject<BluetoothDevice | null>(null);
  public pairedDevices$   = new BehaviorSubject<BluetoothDevice[]>([]);
  public unpairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);

  // El firmware v8 anuncia PROTOCOL_VERSION = 4 en EVT_BOOT. Se inicializa
  // aquí directamente en 4 para evitar un estado transitorio incorrecto
  // durante el primer instante tras conectar (antes de recibir EVT_BOOT).
  public arduinoProtocolVersion$ = new BehaviorSubject<number>(4);
  // v8: valor inicial 4 (antes 3), coherente con arduinoProtocolVersion$ arriba.
  private arduinoProtocolVersion = 4;

  /** Tramas no-ACK que el transporte no gestiona internamente (todo menos
   *  EVT_BOOT/EVT_KEEPALIVE) — BluetoothService se suscribe para decodificar
   *  el dominio (nivel, presión, salidas, snapshot/status, stats). */
  public frame$ = new Subject<RawFrame>();

  // Fix de partición: el heartbeat original comprobaba `cfgInFlight` (no
  // mandar PING mientras hay un CMD_SET_CONFIG en curso) — ese flag es
  // estado de CONFIG, que sigue siendo de BluetoothService. Se expone este
  // interruptor genérico para que la fachada lo active/desactive exactamente
  // en los mismos puntos donde antes tocaba cfgInFlight, sin cambiar el
  // comportamiento del heartbeat.
  public pauseHeartbeat = false;

  // Fix de partición: reconnect() necesitaba rehacer la sincronización de
  // DOMINIO tras reconectar el socket (intención local de enable,
  // requestStatus, persistencia — ver connect() en BluetoothService), así
  // que la orquestación completa de la reconexión vive ahora en la fachada.
  // El transporte solo AVISA cuando el heartbeat considera el enlace
  // muerto; BluetoothService se suscribe y hace disconnect()+connect()
  // (sus propios métodos, que ya envuelven a los de aquí).
  public reconnectRequested$ = new Subject<void>();

  // ================================================================
  // 📋 SISTEMA DE LOG
  // ================================================================
  public logEnabled = true;  // activar/desactivar desde consola: bt.logEnabled = false
  public logEntries$ = new BehaviorSubject<LogEntry[]>([]);
  private readonly MAX_LOG_ENTRIES = 200;

  public log(level: LogLevel, category: string, msg: string, data?: any) {
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

  private heartbeatTimer: any = null;
  private readonly HEARTBEAT_INTERVAL_MS = 15000;
  private heartbeatFailCount = 0;
  // Nº de PING consecutivos fallidos antes de forzar una reconexión. Con 1
  // solo fallo reconectaríamos por cualquier trama perdida puntual (ruido
  // normal del enlace); con 3 (45s de silencio total) distinguimos ruido
  // de un enlace genuinamente muerto/"fantasma".
  private readonly HEARTBEAT_FAIL_THRESHOLD = 3;

  // Fix: mismo motivo que WRITE_TIMEOUT en writeBytes() -- bluetoothSerial.
  // connect() puede quedarse "fantasma" (sin llamar a ningún callback) igual
  // que write(). Sin timeout, connect() nunca resuelve ni rechaza, así que
  // el finally de reconnect() (en BluetoothService — orquesta la
  // reconexión completa porque necesita rehacer la sincronización de
  // dominio, no solo el socket) que libera su guarda de reentrada tampoco
  // se ejecuta nunca, convirtiendo todas las reconexiones futuras en un
  // no-op silencioso — visto en vivo: un connect() colgado minutos, seguido
  // de "reconectando" en bucle sin hacer nada real.
  // v2: subido de 15000 a 30000 tras ver en logcat real que el propio plugin
  // nativo (BluetoothSerialService) hace DOS intentos secuenciales cuando el
  // socket RFCOMM "normal" falla: uno con el socket seguro estándar (~12s
  // hasta el IOException "read failed, timeout") y, si falla, un fallback
  // por reflexión (createRfcommSocket) pensado justo para módulos como el
  // HC-06 que no implementan SDP correctamente (~10-12s más). Con 15s
  // nuestro propio timeout cortaba ese segundo intento a mitad, antes de que
  // tuviera ocasión de tener éxito — descartando por impaciencia justo el
  // camino que más veces suele funcionar con estos módulos.
  private readonly CONNECT_TIMEOUT_MS = 30000;

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

  constructor(private zone: NgZone) {}

  // ================================================================
  // 🔎 ESCANEO / EMPAREJAMIENTO
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

  // Fix: el plugin original no tenía forma de eliminar un emparejamiento —
  // ver patches/cordova-plugin-bluetooth-serial+*.patch, que le añade la
  // acción nativa "unpair" (removeBond() por reflexión, Android only). Si el
  // dispositivo a eliminar es el que está conectado ahora mismo, se
  // desconecta antes: no tiene sentido pedir quitar el vínculo con el socket
  // RFCOMM todavía abierto.
  async unpairDevice(address: string): Promise<void> {
    if (typeof bluetoothSerial?.unpair !== 'function') {
      throw new Error('Esta plataforma no soporta eliminar emparejamientos');
    }
    if (this.isConnected$.value && this.connectedDevice$.value?.address === address) {
      await this.disconnect().catch(() => {});
    }
    await new Promise<void>((resolve, reject) => {
      bluetoothSerial.unpair(address, () => resolve(), (e: any) => reject(e));
    });
  }

  /**
   * Elimina el emparejamiento de TODOS los dispositivos de pairedDevices$.
   * Sigue con el resto aunque alguno falle (en vez de abortar al primer
   * error) y devuelve cuántos se eliminaron y cuáles fallaron con su motivo,
   * para que la UI pueda informar con precisión en vez de un simple
   * todo-o-nada. Refresca pairedDevices$ al terminar.
   */
  async unpairAllPaired(): Promise<{ removed: number; failed: { device: BluetoothDevice; error: any }[] }> {
    const devices = this.pairedDevices$.value;
    let removed = 0;
    const failed: { device: BluetoothDevice; error: any }[] = [];

    for (const dev of devices) {
      try {
        await this.unpairDevice(dev.address);
        removed++;
      } catch (e) {
        this.log('warn', 'UNPAIR', `No se pudo eliminar ${dev.name} (${dev.address})`, e);
        failed.push({ device: dev, error: e });
      }
    }

    await this.loadPairedDevices().catch(() => {});
    return { removed, failed };
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

  // ================================================================
  // 🔌 CONEXIÓN
  // ================================================================
  // Nota de partición: aquí termina lo que hacía connect() antes de la
  // sincronización de dominio (intención local de enable, requestStatus,
  // persistencia, arranque del heartbeat) — eso ahora vive en
  // BluetoothService.connect(), que llama a este método primero y luego hace
  // esa parte, en el MISMO orden que antes (el heartbeat se arrancaba al
  // final de todo eso, no nada más conectar el socket — ver
  // adaptToProtocolVersion(), ahora público, que la fachada llama ella misma
  // al final para no adelantar el primer PING del heartbeat).
  async connect(deviceOrAddress: BluetoothDevice | string): Promise<void> {
    const address = typeof deviceOrAddress === 'string' ? deviceOrAddress : deviceOrAddress.address;
    this.device   = typeof deviceOrAddress === 'string' ? { name: address, address } : deviceOrAddress;
    this.log('info', 'CONNECT', `Conectando a ${this.device.name} (${address})`);

    try { bluetoothSerial.unsubscribeRawData(() => {}, () => {}); } catch {}
    try { bluetoothSerial.unsubscribe(() => {}, () => {}); } catch {}

    // Fix: ver nota junto a CONNECT_TIMEOUT_MS. El patrón "settled" ignora
    // con seguridad un callback nativo tardío que llegue después de que el
    // timeout ya haya resuelto la promesa (igual que en writeBytes()).
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('CONNECT_TIMEOUT'));
      }, this.CONNECT_TIMEOUT_MS);

      bluetoothSerial.connect(
        address,
        () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); },
        (e: any) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
      );
    });

    this.log('info', 'CONNECT', `Conexión BT establecida con ${this.device.name}`);
    this.zone.run(() => {
      this.isConnected$.next(true);
      this.connectedDevice$.next(this.device);
    });
    this.subscribeToIncomingRaw();

    await new Promise(r => setTimeout(r, 500));
  }

  async disconnect(): Promise<void> {
    this.log('info', 'CONNECT', 'Desconectando...');
    this.stopHeartbeat();

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
  public adaptToProtocolVersion() {
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
      if (!this.isConnected$.value || this.pauseHeartbeat) return;
      this.sendCmd(CMD_PING, undefined, 3000, 'low').then(() => {
        this.heartbeatFailCount = 0;
      }).catch(() => {
        this.heartbeatFailCount++;
        this.log('warn', 'HEARTBEAT', `PING sin respuesta (${this.heartbeatFailCount}/${this.HEARTBEAT_FAIL_THRESHOLD})`);
        if (this.heartbeatFailCount >= this.HEARTBEAT_FAIL_THRESHOLD) {
          this.heartbeatFailCount = 0;
          this.log('warn', 'HEARTBEAT', 'Enlace considerado muerto — reconectando');
          this.reconnectRequested$.next();
        }
      });
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
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

    out[o++] = SOF1;
    out[o++] = SOF2;
    out[o++] = VER;
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

  public sendCmd(
    cmdType: number,
    payload?: Uint8Array,
    timeoutMs = 3000,
    priority: CmdPriority = 'high',
    attempts?: number,
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

      const entry: QueuedCmd = { cmdType, payload, timeoutMs, priority, attempts, resolve, reject };

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
        // hasta ~9.7s con reintentos. entry.attempts permite a un comando
        // 'high' concreto pedir menos intentos que el resto (ver nota junto
        // a QueuedCmd.attempts).
        const attempts = entry.attempts ?? (entry.priority === 'low' ? 1 : 3);
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
        case 'SOF1':    if (b === SOF1) this.rxState = 'SOF2'; break;
        case 'SOF2':    if (b === SOF2) this.rxState = 'VER'; else this.rxState = (b === SOF1) ? 'SOF2' : 'SOF1'; break;
        case 'VER':     if (b !== VER) { this.resetRx(); break; } this.rxState = 'TYPE'; break;
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
          tmp[o++] = VER; tmp[o++] = this.rxType & 0xFF;
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
  private decodeAckError(code: number) {
    if (code === RES_BAD_LEN)  return 'BAD_LEN';
    if (code === RES_BAD_VAL)  return 'BAD_VALUE';
    if (code === RES_BAD_SIDE) return 'BAD_SIDE';
    if (code === RES_CRC_ERR)  return 'CRC_ERR';
    return `ERR_${code}`;
  }

  private dispatchFrame(type: number, seq: number, payload: Uint8Array) {
    if ((type & ACK_BASE) === ACK_BASE) {
      const result = payload.length >= 1 ? payload[0] : 0xFF;
      const idx = this.queue.findIndex(x => x.seq === seq && type === (ACK_BASE | (x.cmdType & 0x7F)));
      if (idx !== -1) {
        const cur = this.queue[idx];
        clearTimeout(cur.timer);
        this.queue.splice(idx, 1);
        if (result === RES_OK) {
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

    // EVT_BOOT se gestiona aquí (no se reenvía por frame$) porque controla
    // directamente el heartbeat del propio transporte.
    if (type === EVT_BOOT) {
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
    }

    if (type === EVT_KEEPALIVE) return;

    // Todo lo demás (EVT_DIST/RELAY/SNAPSHOT/STATUS/RELAYSTAT/LEVEL/
    // HIGH_PRESSURE) es dominio del atomizador — lo decodifica BluetoothService.
    this.frame$.next({ type, seq, payload });
  }
}
