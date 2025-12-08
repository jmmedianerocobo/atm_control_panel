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
  // ESTADOS PÚBLICOS
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

  public retardoEntradaDist$ = new BehaviorSubject<number>(200);
  public retardoSalidaDist$ = new BehaviorSubject<number>(250);
  public litersPerMin$ = new BehaviorSubject<number>(10);
  public numApplicators$ = new BehaviorSubject<number>(2);

  public mode$ = new BehaviorSubject<0 | 1>(0);

  public activeTimeMs$ = new BehaviorSubject<number>(2000);


  public pairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);
  public unpairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);

  // ================================================================
  // CONTROL INTERNO
  // ================================================================
  private commandId = 1;
  private queue: PendingCommand[] = [];
  private isProcessingQueue = false;

  private readonly END_TOKEN = '~end~';

  constructor(private zone: NgZone) {
    console.log('[BT] Servicio Bluetooth cargado');
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
            console.log('[BT] Conectado');
            this.isConnected$.next(true);

            this.subscribeToIncoming();

            this.requestStatus().catch(() => {});
            this.requestStats().catch(() => {});

            resolve();
          });
        },
        (err: any) => {
          console.error('[BT] Error conectando:', err);
          reject(err);
        }
      );
    });
  }

  async disconnect(): Promise<void> {
    return new Promise(resolve => {
      try {
        bluetoothSerial.unsubscribe(
          () => console.log('[BT] unsubscribe OK'),
          (err: any) => console.warn('[BT] unsubscribe error', err)
        );
      } catch {}

      bluetoothSerial.disconnect(() => {
        this.zone.run(() => {
          console.log('[BT] Desconectado');
          this.isConnected$.next(false);
        });
        this.queue = [];
        resolve();
      });
    });
  }

  // ================================================================
  // EMPAREJADOS
  // ================================================================
  async loadPairedDevices(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!bluetoothSerial) return reject('bluetoothSerial no disponible');

      bluetoothSerial.list(
        (devices: any[]) => {
          const mapped = devices.map(d => ({
            name: d.name,
            address: d.address,
            id: d.id || d.address,
          })) as BluetoothDevice[];

          this.zone.run(() => this.pairedDevices$.next(mapped));
          resolve();
        },
        (err: any) => reject(err)
      );
    });
  }

  // ================================================================
  // ESCANEO NO EMPAREJADOS
  // ================================================================
  async scanForUnpaired(): Promise<void> {
    return new Promise((resolve, reject) => {
      bluetoothSerial.discoverUnpaired(
        (devices: any[]) => {
          const mapped = devices.map(d => ({
            name: d.name || 'Sin nombre',
            address: d.address,
            id: d.id || d.address,
          })) as BluetoothDevice[];

          this.zone.run(() => this.unpairedDevices$.next(mapped));
          resolve();
        },
        (err: any) => reject(err)
      );
    });
  }

  // ================================================================
  // ENVÍO DE COMANDOS (~end~)
  // ================================================================
  private sendCommand(cmd: string, extra: any = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected$.value) {
        reject('Not connected');
        return;
      }

      const id = this.commandId++;
      const payload = { cmd, id, ...extra };
      const line = JSON.stringify(payload) + this.END_TOKEN;

      const entry: PendingCommand = {
        resolve,
        reject,
        cmd,
        id,
        timer: null,
      };

      this.queue.push(entry);

      console.log('[BT >>]', line);

      bluetoothSerial.write(
        line,
        () => this.processQueue(),
        (err: any) => {
          console.error('[BT] Error write:', err);
          reject(err);
        }
      );
    });
  }

  private processQueue() {
    if (this.isProcessingQueue) return;
    if (this.queue.length === 0) return;

    const current = this.queue[0];
    this.isProcessingQueue = true;

    current.timer = setTimeout(() => {
      console.warn('[BT] ACK timeout', current.cmd, current.id);
      current.reject('ACK timeout');
      this.queue.shift();
      this.isProcessingQueue = false;
      this.processQueue();
    }, 1500);
  }

  // ================================================================
  // RECEPCIÓN (~end~)
  // ================================================================
  private subscribeToIncoming() {
    bluetoothSerial.subscribe(
      this.END_TOKEN,
      (text: string) => {
        const packet = text.replace(this.END_TOKEN, '').trim();

        if (!packet) return;

        console.log('[BT <<]', packet);

        this.zone.run(() => this.handleIncoming(packet));
      },
      (err: any) => console.error('[BT] subscribe error', err)
    );
  }

  private handleIncoming(raw: string) {
    let json: any;

    try {
      json = JSON.parse(raw);
    } catch {
      console.warn('[BT] JSON inválido:', raw);
      return;
    }

    // ====== ERROR ======
    if (json.error !== undefined) {
      console.warn('[BT] Arduino ERROR:', json.error);

      if (this.queue.length > 0) {
        const current = this.queue[0];
        clearTimeout(current.timer);
        current.reject(json.error);
        this.queue.shift();
        this.isProcessingQueue = false;
        this.processQueue();
      }
      return;
    }

    // ====== ACK ======
    if (json.ack !== undefined) {
      if (this.queue.length > 0) {
        const current = this.queue[0];
        clearTimeout(current.timer);
        current.resolve();
        this.queue.shift();
        this.isProcessingQueue = false;
        this.processQueue();
      }

      if (json.ack === 'activateLeft') this.relayLeft$.next(true);
      if (json.ack === 'deactivateLeft') this.relayLeft$.next(false);
      if (json.ack === 'activateRight') this.relayRight$.next(true);
      if (json.ack === 'deactivateRight') this.relayRight$.next(false);

      return;
    }

    // ====== DISTANCIAS ======
    if (json.log === 'LEFT') {
      this.distanceLeft$.next(json.dist);
      return;
    }

    if (json.log === 'RIGHT') {
      this.distanceRight$.next(json.dist);
      return;
    }

    // ====== STATUS ======
    if (json.status) {
      this.distanceLeft$.next(json.status.L);
      this.distanceRight$.next(json.status.R);

      this.relayLeft$.next(!!json.status.RL);
      this.relayRight$.next(!!json.status.RR);
      return;
    }

    // ====== STATS ======
    if (json.stats) {
      console.log('[BT] Stats:', json.stats);
      return;
    }
  }

  // ================================================================
  // API PÚBLICA
  // ================================================================
  activateLeft() { return this.sendCommand('activateLeft'); }
  deactivateLeft() { return this.sendCommand('deactivateLeft'); }

  activateRight() { return this.sendCommand('activateRight'); }
  deactivateRight() { return this.sendCommand('deactivateRight'); }

  requestStatus() { return this.sendCommand('STATUS'); }
  requestStats() { return this.sendCommand('STATS'); }

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
    this.activeTimeMs$.next(v);
    return this.sendCommand('SET_ACTIVE_TIME', { value: v });
  }


  setMode(v: 0 | 1) {
  this.mode$.next(v);
  return this.sendCommand('SET_MODE', { value: v });
}


  setMaxValidDistanceCm(v: number) {
    this.maxValidDistanceCm$.next(v);
    return this.sendCommand('SET_MAX_DISTANCE', { value: v });
  }

  setRetardoEntradaDist(v: number) {
  this.retardoEntradaDist$.next(v);
  }

  setRetardoSalidaDist(v: number) {
    this.retardoSalidaDist$.next(v);
  }

  setLitersPerMin(v: number) {
    this.litersPerMin$.next(v);
  }

  setNumApplicators(v: number) {
    this.numApplicators$.next(v);
  }


}

