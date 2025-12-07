import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

declare var bluetoothSerial: any;

export interface BluetoothDevice {
  name: string;
  address: string;
  id?: string;
}

interface PendingCommand {
  resolve: () => void;
  reject: (msg: any) => void;
  cmd: string;
  id: number;
  timer: any;
}

@Injectable({ providedIn: 'root' })
export class BluetoothService {

  // ================================================================
  //  ESTADOS PÚBLICOS
  // ================================================================
  public isConnected$ = new BehaviorSubject<boolean>(false);

  public distanceLeft$ = new BehaviorSubject<number | null>(null);
  public distanceRight$ = new BehaviorSubject<number | null>(null);

  public relayLeft$ = new BehaviorSubject<boolean>(false);
  public relayRight$ = new BehaviorSubject<boolean>(false);

  public thresholdCm$ = new BehaviorSubject<number>(30);
  public hysteresisCm$ = new BehaviorSubject<number>(10);
  public holdTimeMs$ = new BehaviorSubject<number>(300);
  public maxValidDistanceCm$ = new BehaviorSubject<number>(250);

  // ⭐ Correctos
  public pairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);
  public unpairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);

  // ================================================================
  // CONTROL INTERNO
  // ================================================================
  private commandId = 1;
  private queue: PendingCommand[] = [];
  private isProcessingQueue = false;

  constructor(private zone: NgZone) {
    console.log('%c[BT] Servicio Bluetooth cargado', 'color:#22aa22;font-weight:bold;');
  }

  // ================================================================
  // CONEXIÓN
  // ================================================================
  async connect(address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[BT] Conectando a', address);

      bluetoothSerial.connect(
        address,
        () => {
          this.zone.run(() => {
            this.isConnected$.next(true);
            this.subscribeToIncoming();

            // Solicitar estado inicial
            this.requestStatus().catch(() => {});
            this.requestStats().catch(() => {});

            resolve();
          });
        },
        (err: any) => reject(err)
      );
    });
  }

  async disconnect(): Promise<void> {
    return new Promise(resolve => {
      bluetoothSerial.disconnect(() => {
        this.zone.run(() => this.isConnected$.next(false));
        this.queue = [];
        this.unpairedDevices$.next([]);
        resolve();
      });
    });
  }

  // ================================================================
  // EMPAREJADOS
  // ================================================================
  async loadPairedDevices(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!bluetoothSerial) return reject("bluetoothSerial no disponible");

      bluetoothSerial.list(
        (devices: any[]) => {
          const mapped = devices.map(d => ({
            name: d.name,
            address: d.address,
            id: d.id || d.address
          })) as BluetoothDevice[];

          this.zone.run(() => this.pairedDevices$.next(mapped));
          resolve();
        },
        (err: any) => reject(err)
      );
    });
  }

  // ================================================================
  //  ESCANEO — NO EMPAREJADOS
  // ================================================================
  async scanForUnpaired(): Promise<void> {
    return new Promise((resolve, reject) => {
      bluetoothSerial.discoverUnpaired(
        (devices: any[]) => {
          const mapped = devices.map(d => ({
            name: d.name || 'Sin nombre',
            address: d.address,
            id: d.id || d.address
          })) as BluetoothDevice[];

          this.zone.run(() => this.unpairedDevices$.next(mapped));
          resolve();
        },
        (err: any) => reject(err)

      );
    });
  }

  // ================================================================
  // ENVÍO CON COLA + TIMEOUT
  // ================================================================
  private sendCommand(cmd: string, extra: any = {}): Promise<void> {
    return new Promise((resolve, reject) => {

      if (!this.isConnected$.value) {
        reject('Not connected');
        return;
      }

      const id = this.commandId++;
      const payload = { cmd, id, ...extra };
      const line = JSON.stringify(payload) + '\n';

      const entry: PendingCommand = {
        resolve,
        reject,
        cmd,
        id,
        timer: null
      };

      this.queue.push(entry);

      bluetoothSerial.write(line);  // primero escribir
      this.processQueue();          // luego procesar
    });
  }

  private processQueue() {
    if (this.isProcessingQueue) return;
    if (this.queue.length === 0) return;

    this.isProcessingQueue = true;
    const current = this.queue[0];

    current.timer = setTimeout(() => {
      current.reject('ACK timeout');
      this.queue.shift();
      this.isProcessingQueue = false;
      this.processQueue();
    }, 1200);
  }

  // ================================================================
  // API PÚBLICA
  // ================================================================
  activateLeft()        { return this.sendCommand('activateLeft'); }
  deactivateLeft()      { return this.sendCommand('deactivateLeft'); }

  activateRight()       { return this.sendCommand('activateRight'); }
  deactivateRight()     { return this.sendCommand('deactivateRight'); }

  requestStatus()       { return this.sendCommand('STATUS'); }
  requestStats()        { return this.sendCommand('STATS'); }

  resetArduinoFilters() { return this.sendCommand('RESET_FILTER'); }

  setThresholdCm(v: number) {
    this.thresholdCm$.next(v);
    return this.sendCommand('SET_THRESHOLD', { value: v });
  }

  setHysteresisCm(v: number) {
    this.hysteresisCm$.next(v);
    return this.sendCommand('SET_HYSTERESIS', { value: v });
  }

  setHoldTimeMs(v: number) {
    this.holdTimeMs$.next(v);
    return this.sendCommand('SET_HOLD', { value: v });
  }

  setActiveTimeMs(v: number) {
    return this.sendCommand('SET_ACTIVE_TIME', { value: v });
  }

  setMode(v: 0 | 1) {
    return this.sendCommand('SET_MODE', { value: v });
  }

  setMaxValidDistanceCm(v: number) {
    this.maxValidDistanceCm$.next(v);
    return this.sendCommand('SET_MAX_DISTANCE', { value: v });
  }

  // ================================================================
  // RECEPCIÓN
  // ================================================================
 private incomingBuffer = "";

private subscribeToIncoming() {
  bluetoothSerial.subscribeRawData((data: ArrayBuffer) => {
    const text = new TextDecoder().decode(data);

    this.processRawText(text);
  });
}

private processRawText(text: string) {
  // agregamos el texto recibido al buffer
  this.incomingBuffer += text;

  let idx;
  // mientras haya mensajes completos
  while ((idx = this.incomingBuffer.indexOf("~end~")) >= 0) {
    const packet = this.incomingBuffer.substring(0, idx).trim();
    this.incomingBuffer = this.incomingBuffer.substring(idx + 5); // 5 chars "~end~"

    if (packet.length > 0) {
      // process JSON safely
      this.zone.run(() => this.handleIncoming(packet));
    }
  }
}

  private handleIncoming(raw: string) {
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }

    // ACK
    if (json.ack !== undefined) {
      if (this.queue.length === 0) return;

      const current = this.queue[0];
      clearTimeout(current.timer);

      current.resolve();
      this.queue.shift();
      this.isProcessingQueue = false;
      this.processQueue();

      if (json.ack === 'activateLeft')  this.relayLeft$.next(true);
      if (json.ack === 'deactivateLeft') this.relayLeft$.next(false);

      if (json.ack === 'activateRight')  this.relayRight$.next(true);
      if (json.ack === 'deactivateRight') this.relayRight$.next(false);

      return;
    }

    // DISTANCIAS
    if (json.log === 'LEFT')  { this.distanceLeft$.next(json.dist); return; }
    if (json.log === 'RIGHT') { this.distanceRight$.next(json.dist); return; }

    // STATUS
    if (json.status) {
      this.distanceLeft$.next(json.status.L);
      this.distanceRight$.next(json.status.R);

      this.relayLeft$.next(!!json.status.RL);
      this.relayRight$.next(!!json.status.RR);
    }
  }
}
