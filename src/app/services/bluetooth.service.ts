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
  reject: (e: any) => void;
  cmdType: number;
  seq: number;
  timer: any;
}

export type RelayStats = {
  L: { timeMs: number; activations: number };
  R: { timeMs: number; activations: number };
};

@Injectable({ providedIn: 'root' })
export class BluetoothService {

  // ================================================================
  // 🔵 ESTADOS PÚBLICOS
  // ================================================================
  public isConnected$ = new BehaviorSubject<boolean>(false);

  // Listas para pantallas de BT settings (compatibilidad)
  public pairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);
  public unpairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);

  // Sensores / estado
  public distanceLeft$ = new BehaviorSubject<number>(0);
  public distanceRight$ = new BehaviorSubject<number>(0);

  public relayLeft$ = new BehaviorSubject<boolean>(false);
  public relayRight$ = new BehaviorSubject<boolean>(false);

  public enabledLeft$ = new BehaviorSubject<boolean>(true);
  public enabledRight$ = new BehaviorSubject<boolean>(true);

  // Config Arduino (source of truth tras STATUS/SNAPSHOT)
  public mode$ = new BehaviorSubject<0 | 1>(0);
  public thresholdCm$ = new BehaviorSubject<number>(30);
  public hysteresisCm$ = new BehaviorSubject<number>(0);

  public retardoEntradaDist$ = new BehaviorSubject<number>(300);
  public retardoSalidaDist$ = new BehaviorSubject<number>(300);

  public retardoEntradaTemp$ = new BehaviorSubject<number>(0);
  public activeTimeModo1$ = new BehaviorSubject<number>(2000);

  // Stats (compatibilidad para DistanceViewPage)
  public relayStats$ = new BehaviorSubject<RelayStats>({
    L: { timeMs: 0, activations: 0 },
    R: { timeMs: 0, activations: 0 },
  });

  // Stats (granular)
  public relayLeftTimeMs$ = new BehaviorSubject<number>(0);
  public relayLeftActivations$ = new BehaviorSubject<number>(0);
  public relayRightTimeMs$ = new BehaviorSubject<number>(0);
  public relayRightActivations$ = new BehaviorSubject<number>(0);

  // Solo-app
  public litersPerMin$ = new BehaviorSubject<number>(0);
  public numApplicators$ = new BehaviorSubject<number>(1);

  public grPerSec$ = new BehaviorSubject<number>(100);

  // ================================================================
  // 🧩 PROTOCOLO (igual que Arduino)
  // ================================================================
  private readonly SOF1 = 0xAA;
  private readonly SOF2 = 0x55;
  private readonly VER  = 0x01;

  private readonly ACK_BASE = 0x80;

  private readonly CMD_PING          = 0x01;
  private readonly CMD_SET_CONFIG    = 0x02;
  private readonly CMD_GET_STATUS    = 0x03;
  private readonly CMD_GET_RELAYSTAT = 0x04;
  private readonly CMD_SET_ENABLE    = 0x05;
  private readonly CMD_RESET_RELAYSTAT = 0x06;

  // ✅ simulación modo 1 + STOP
  private readonly CMD_TEST_TRIGGER   = 0x07; // payload 1 byte: 'L'/'R'
  private readonly CMD_EMERGENCY_STOP = 0x08; // sin payload

  private readonly EVT_BOOT      = 0x10;
  private readonly EVT_DIST      = 0x11;
  private readonly EVT_RELAY     = 0x12;
  private readonly EVT_SNAPSHOT  = 0x13;
  private readonly EVT_STATUS    = 0x14;
  private readonly EVT_RELAYSTAT = 0x15;

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

  private cmdChain: Promise<any> = Promise.resolve();
  private readonly MAX_LEN = 64;

  private cfgTimer: any = null;
  private cfgInFlight = false;
  private cfgDirty = false;
  private readonly CFG_DEBOUNCE_MS = 200;

  // Señal para esperar un EVT_STATUS "nuevo"
  private statusTick$ = new BehaviorSubject<number>(0);

  // ✅ Heartbeat / watchdog
  private heartbeatTimer: any = null;
  private readonly HEARTBEAT_INTERVAL_MS = 15000; // 15s

  // ✅ Evitar reconexiones simultáneas
  private reconnecting = false;

  // ================================================================
  // 📩 RX state machine
  // ================================================================
  private rxState:
    | 'SOF1' | 'SOF2' | 'VER' | 'TYPE'
    | 'SEQ0' | 'SEQ1' | 'LEN0' | 'LEN1'
    | 'PAYLOAD' | 'CRC0' | 'CRC1' = 'SOF1';

  private rxType = 0;
  private rxSeq = 0;
  private rxLen = 0;
  private rxPayload = new Uint8Array(512);
  private rxOff = 0;
  private rxCrc = 0;

  constructor(private zone: NgZone) {}

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
      if (typeof fn !== 'function') {
        reject(new Error('discoverUnpaired not supported by this plugin'));
        return;
      }
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
    const address = typeof deviceOrAddress === 'string'
      ? deviceOrAddress
      : deviceOrAddress.address;

    this.device = typeof deviceOrAddress === 'string'
      ? { name: address, address }
      : deviceOrAddress;

    // Cleanup defensivo
    try { bluetoothSerial.unsubscribeRawData(() => {}, () => {}); } catch {}
    try { bluetoothSerial.unsubscribe(() => {}, () => {}); } catch {}

    await new Promise<void>((resolve, reject) => {
      bluetoothSerial.connect(address, () => resolve(), (e: any) => reject(e));
    });

    this.zone.run(() => this.isConnected$.next(true));
    this.subscribeToIncomingRaw();

    // Sync inicial
    await this.requestStatus().catch(() => {});
    await this.requestRelayStats().catch(() => {});

    this.startHeartbeat();
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();

    if (this.cfgTimer) {
      clearTimeout(this.cfgTimer);
      this.cfgTimer = null;
    }
    this.cfgDirty = false;
    this.cfgInFlight = false;

    // Cancelar comandos en espera
    this.queue.forEach(cmd => {
      clearTimeout(cmd.timer);
      cmd.reject('Disconnected');
    });
    this.queue = [];

    this.resetRx();

    try { bluetoothSerial.unsubscribeRawData(() => {}, () => {}); } catch {}
    try { bluetoothSerial.unsubscribe(() => {}, () => {}); } catch {}

    await new Promise<void>((resolve) => {
      bluetoothSerial.disconnect(() => resolve(), () => resolve());
    });

    this.device = null;
    this.zone.run(() => this.isConnected$.next(false));
  }

  // ================================================================
  // ✅ HEARTBEAT / WATCHDOG
  // ================================================================
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected$.value) return;
      // si hay envío de config en vuelo, no molestes
      if (this.cfgInFlight) return;

      this.ping().catch(() => {
        console.warn('⚠️ Heartbeat failed, attempting reconnect...');
        this.reconnect().catch(() => {});
      });
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    if (!this.device) return;

    this.reconnecting = true;

    // Serializa la reconexión contra cmdChain para que no pise envíos
    const run = async () => {
      const deviceToReconnect = this.device!;
      try {
        await this.disconnect();
      } catch {}
      await new Promise(r => setTimeout(r, 800));

      try {
        await this.connect(deviceToReconnect);
        console.log('✅ Reconnected successfully');
      } catch (e) {
        console.error('❌ Reconnection failed:', e);
      }
    };

    try {
      const chained = this.cmdChain.then(run, run);
      this.cmdChain = chained.catch(() => {});
      await chained;
    } finally {
      this.reconnecting = false;
    }
  }

  // ================================================================
  // 🧮 CRC16/CCITT-FALSE
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
  // 🧱 Construcción de trama
  // ================================================================
  private buildFrame(type: number, seq: number, payload?: Uint8Array): Uint8Array {
    const len = payload?.length ?? 0;
    const header = 2 + 1 + 1 + 2 + 2; // SOF1 SOF2 VER TYPE SEQ LEN
    const total = header + len + 2;   // + CRC16

    const out = new Uint8Array(total);
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

    // CRC sobre: VER..PAYLOAD (excluye SOF)
    const crcData = out.slice(2, 2 + 1 + 1 + 2 + 2 + len);
    const crc = this.crc16_ccitt(crcData);

    out[o++] = crc & 0xFF;
    out[o++] = (crc >> 8) & 0xFF;

    return out;
  }

  private nextSeq(): number {
    const v = this.seqTx & 0xFFFF;
    this.seqTx = (this.seqTx + 1) & 0xFFFF;
    return v;
  }

  // ================================================================
  // 🧾 WRITE (SIEMPRE ArrayBuffer) -> evita CRC corrupto
  // ================================================================
  private async writeBytes(bytes: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const arrBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      bluetoothSerial.write(arrBuf, () => resolve(), (e: any) => reject(e));
    });
  }

  // ================================================================
  // 🚀 ENVÍO DE COMANDOS (serializado + retry)
  // ================================================================
  private async sendCmdInternal(cmdType: number, payload?: Uint8Array, timeoutMs = 3000): Promise<void> {
    if (!this.isConnected$.value) throw new Error('Not connected');

    const len = payload?.length ?? 0;
    if (len > this.MAX_LEN) throw new Error('BAD_LEN');

    const seq = this.nextSeq();
    const frame = this.buildFrame(cmdType, seq, payload);

    const p = new Promise<void>((resolve, reject) => {
      const entry: PendingCommand = { resolve, reject, cmdType, seq, timer: null };
      entry.timer = setTimeout(() => {
        this.queue = this.queue.filter(x => x.seq !== seq);
        reject('ACK timeout');
      }, timeoutMs);
      this.queue.push(entry);
    });

    await this.writeBytes(frame);
    return p;
  }

  private sendCmd(cmdType: number, payload?: Uint8Array, timeoutMs = 3000): Promise<void> {
    const run = async () => this.sendCmdWithRetry(cmdType, payload, timeoutMs, 3);
    const chained = this.cmdChain.then(run, run);
    this.cmdChain = chained.catch(() => {});
    return chained;
  }

  private async sendCmdWithRetry(cmdType: number, payload: Uint8Array | undefined, timeoutMs: number, attempts: number): Promise<void> {
    let lastErr: any;

    for (let i = 0; i < attempts; i++) {
      try {
        await this.sendCmdInternal(cmdType, payload, timeoutMs);
        return;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e);

        if (msg.includes('BAD_')) break;
        const transient = msg.includes('ACK timeout');
        if (!transient) break;

        const delay = i === 0 ? 200 : i === 1 ? 500 : 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }

    throw lastErr;
  }

  // ================================================================
  // 📩 RX: subscribeRawData + state machine
  // ================================================================
  private subscribeToIncomingRaw() {
    this.resetRx();

    bluetoothSerial.subscribeRawData(
      (data: any) => {
        let bytes: Uint8Array | null = null;

        if (data instanceof ArrayBuffer) {
          bytes = new Uint8Array(data);
        } else if (data?.buffer instanceof ArrayBuffer) {
          bytes = new Uint8Array(data.buffer);
        } else if (Array.isArray(data)) {
          bytes = new Uint8Array(data);
        } else if (typeof data === 'string') {
          const arr = new Uint8Array(data.length);
          for (let i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i) & 0xFF;
          bytes = arr;
        }

        if (!bytes) return;
        this.handleIncomingBytes(bytes);
      },
      (_err: any) => { /* opcional */ }
    );
  }

  private resetRx() {
    this.rxState = 'SOF1';
    this.rxType = 0;
    this.rxSeq = 0;
    this.rxLen = 0;
    this.rxOff = 0;
    this.rxCrc = 0;
  }

  private handleIncomingBytes(bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] & 0xFF;

      switch (this.rxState) {
        case 'SOF1':
          if (b === this.SOF1) this.rxState = 'SOF2';
          break;

        case 'SOF2':
          if (b === this.SOF2) this.rxState = 'VER';
          else this.rxState = (b === this.SOF1) ? 'SOF2' : 'SOF1';
          break;

        case 'VER':
          if (b !== this.VER) { this.resetRx(); break; }
          this.rxState = 'TYPE';
          break;

        case 'TYPE':
          this.rxType = b;
          this.rxState = 'SEQ0';
          break;

        case 'SEQ0':
          this.rxSeq = b;
          this.rxState = 'SEQ1';
          break;

        case 'SEQ1':
          this.rxSeq |= (b << 8);
          this.rxState = 'LEN0';
          break;

        case 'LEN0':
          this.rxLen = b;
          this.rxState = 'LEN1';
          break;

        case 'LEN1':
          this.rxLen |= (b << 8);
          if (this.rxLen > this.MAX_LEN) { this.resetRx(); break; }
          this.rxOff = 0;
          this.rxState = (this.rxLen === 0) ? 'CRC0' : 'PAYLOAD';
          break;

        case 'PAYLOAD':
          this.rxPayload[this.rxOff++] = b;
          if (this.rxOff >= this.rxLen) this.rxState = 'CRC0';
          break;

        case 'CRC0':
          this.rxCrc = b;
          this.rxState = 'CRC1';
          break;

        case 'CRC1': {
          this.rxCrc |= (b << 8);

          const tmp = new Uint8Array(1 + 1 + 2 + 2 + this.rxLen);
          let o = 0;
          tmp[o++] = this.VER;
          tmp[o++] = this.rxType & 0xFF;
          tmp[o++] = this.rxSeq & 0xFF;
          tmp[o++] = (this.rxSeq >> 8) & 0xFF;
          tmp[o++] = this.rxLen & 0xFF;
          tmp[o++] = (this.rxLen >> 8) & 0xFF;
          if (this.rxLen > 0) tmp.set(this.rxPayload.slice(0, this.rxLen), o);

          const calc = this.crc16_ccitt(tmp);
          if (calc === (this.rxCrc & 0xFFFF)) {
            const payload = this.rxPayload.slice(0, this.rxLen);
            this.dispatchFrame(this.rxType, this.rxSeq & 0xFFFF, payload);
          }

          this.resetRx();
          break;
        }
      }
    }
  }

  // ================================================================
  // 🧠 Decodificación (ACK + EVT)
  // ================================================================
  private u16LE(p: Uint8Array, o: number): number {
    return (p[o] | (p[o + 1] << 8)) & 0xFFFF;
  }
  private u32LE(p: Uint8Array, o: number): number {
    return ((p[o]) | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
  }

  private decodeAckError(code: number) {
    if (code === this.RES_BAD_LEN) return 'BAD_LEN';
    if (code === this.RES_BAD_VAL) return 'BAD_VALUE';
    if (code === this.RES_BAD_SIDE) return 'BAD_SIDE';
    if (code === this.RES_CRC_ERR) return 'CRC_ERR';
    return `ERR_${code}`;
  }

  private dispatchFrame(type: number, seq: number, payload: Uint8Array) {
    // ACK
    if ((type & this.ACK_BASE) === this.ACK_BASE) {
      const result = payload.length >= 1 ? payload[0] : 0xFF;

      const idx = this.queue.findIndex(x => x.seq === seq && type === (this.ACK_BASE | (x.cmdType & 0x7F)));
      if (idx !== -1) {
        const cur = this.queue[idx];
        clearTimeout(cur.timer);
        this.queue.splice(idx, 1);

        if (result === this.RES_OK) cur.resolve();
        else cur.reject(this.decodeAckError(result));
      }
      return;
    }

    switch (type) {
      case this.EVT_BOOT:
        return;

      case this.EVT_DIST: {
        if (payload.length < 3) return;
        const side = String.fromCharCode(payload[0]);
        const cm = this.u16LE(payload, 1);

        this.zone.run(() => {
          if (side === 'L') this.distanceLeft$.next(cm);
          if (side === 'R') this.distanceRight$.next(cm);
        });
        return;
      }

      case this.EVT_RELAY: {
        if (payload.length < 3) return;
        const side = String.fromCharCode(payload[0]);
        const state = payload[1] === 1;

        this.zone.run(() => {
          if (side === 'L') this.relayLeft$.next(state);
          if (side === 'R') this.relayRight$.next(state);
        });
        return;
      }

      case this.EVT_SNAPSHOT: {
        if (payload.length < (5 + 2 + 2 + 2 + 2 + 2 + 4)) return;

        const Lr = payload[0] === 1;
        const Rr = payload[1] === 1;
        const enL = payload[2] === 1;
        const enR = payload[3] === 1;
        const m = payload[4] === 1 ? 1 : 0;

        const thr = this.u16LE(payload, 5);
        const hys = this.u16LE(payload, 7);
        const in0 = this.u16LE(payload, 9);
        const out0 = this.u16LE(payload, 11);
        const in1 = this.u16LE(payload, 13);
        const active1 = this.u32LE(payload, 15);

        this.zone.run(() => {
          this.relayLeft$.next(Lr);
          this.relayRight$.next(Rr);

          this.enabledLeft$.next(enL);
          this.enabledRight$.next(enR);

          this.mode$.next(m);
          this.thresholdCm$.next(thr);
          this.hysteresisCm$.next(hys);
          this.retardoEntradaDist$.next(in0);
          this.retardoSalidaDist$.next(out0);
          this.retardoEntradaTemp$.next(in1);
          this.activeTimeModo1$.next(active1);
        });
        return;
      }

      case this.EVT_STATUS: {
        if (payload.length < (4 + 5 + 2 + 2 + 2 + 2 + 2 + 4)) return;

        const dL = this.u16LE(payload, 0);
        const dR = this.u16LE(payload, 2);

        const RL = payload[4] === 1;
        const RR = payload[5] === 1;
        const enL = payload[6] === 1;
        const enR = payload[7] === 1;
        const m = payload[8] === 1 ? 1 : 0;

        const thr = this.u16LE(payload, 9);
        const hys = this.u16LE(payload, 11);
        const in0 = this.u16LE(payload, 13);
        const out0 = this.u16LE(payload, 15);
        const in1 = this.u16LE(payload, 17);
        const active1 = this.u32LE(payload, 19);

        this.zone.run(() => {
          this.distanceLeft$.next(dL);
          this.distanceRight$.next(dR);

          this.relayLeft$.next(RL);
          this.relayRight$.next(RR);

          this.enabledLeft$.next(enL);
          this.enabledRight$.next(enR);

          this.mode$.next(m);
          this.thresholdCm$.next(thr);
          this.hysteresisCm$.next(hys);
          this.retardoEntradaDist$.next(in0);
          this.retardoSalidaDist$.next(out0);
          this.retardoEntradaTemp$.next(in1);
          this.activeTimeModo1$.next(active1);

          this.statusTick$.next(this.statusTick$.value + 1);
        });
        return;
      }

      case this.EVT_RELAYSTAT: {
        if (payload.length < 16) return;

        const leftTime = this.u32LE(payload, 0);
        const leftActs = this.u32LE(payload, 4);
        const rightTime = this.u32LE(payload, 8);
        const rightActs = this.u32LE(payload, 12);

        this.zone.run(() => {
          this.relayLeftTimeMs$.next(leftTime);
          this.relayLeftActivations$.next(leftActs);
          this.relayRightTimeMs$.next(rightTime);
          this.relayRightActivations$.next(rightActs);

          this.relayStats$.next({
            L: { timeMs: leftTime, activations: leftActs },
            R: { timeMs: rightTime, activations: rightActs },
          });
        });
        return;
      }
    }
  }

  // ================================================================
  // 🛠️ CONFIG: debounce + confirmación
  // ================================================================
  private scheduleConfigSend() {
    this.cfgDirty = true;
    if (this.cfgTimer) clearTimeout(this.cfgTimer);
    this.cfgTimer = setTimeout(() => {
      this.flushConfig().catch(() => {});
    }, this.CFG_DEBOUNCE_MS);
  }

  private snapshotConfig() {
    return {
      mode: (this.mode$.value ?? 0) as 0 | 1,
      thresholdCm: Math.round(this.thresholdCm$.value),
      hysteresisCm: Math.round(this.hysteresisCm$.value),
      retardoEntradaDist: Math.round(this.retardoEntradaDist$.value),
      retardoSalidaDist: Math.round(this.retardoSalidaDist$.value),
      retardoEntradaTemp: Math.round(this.retardoEntradaTemp$.value),
      activeTimeModo1: Math.round(this.activeTimeModo1$.value),
    };
  }

  private validateConfig(c: ReturnType<BluetoothService['snapshotConfig']>) {
    if (!(c.mode === 0 || c.mode === 1)) throw new Error('BAD_VALUE');
    if (c.thresholdCm < 5 || c.thresholdCm > 300) throw new Error('BAD_VALUE');
    if (c.hysteresisCm < 0 || c.hysteresisCm > 100) throw new Error('BAD_VALUE');
    if (c.retardoEntradaDist < 0 || c.retardoEntradaDist > 60000) throw new Error('BAD_VALUE');
    if (c.retardoSalidaDist < 0 || c.retardoSalidaDist > 60000) throw new Error('BAD_VALUE');
    if (c.retardoEntradaTemp < 0 || c.retardoEntradaTemp > 60000) throw new Error('BAD_VALUE');
    if (c.activeTimeModo1 < 0 || c.activeTimeModo1 > 600000) throw new Error('BAD_VALUE');
  }

  private buildConfigPayload(c: ReturnType<BluetoothService['snapshotConfig']>): Uint8Array {
    const pl = new Uint8Array(15);
    let o = 0;

    pl[o++] = c.mode & 0xFF;

    pl[o++] = c.thresholdCm & 0xFF;   pl[o++] = (c.thresholdCm >> 8) & 0xFF;
    pl[o++] = c.hysteresisCm & 0xFF;  pl[o++] = (c.hysteresisCm >> 8) & 0xFF;

    pl[o++] = c.retardoEntradaDist & 0xFF; pl[o++] = (c.retardoEntradaDist >> 8) & 0xFF;
    pl[o++] = c.retardoSalidaDist & 0xFF;  pl[o++] = (c.retardoSalidaDist >> 8) & 0xFF;

    pl[o++] = c.retardoEntradaTemp & 0xFF; pl[o++] = (c.retardoEntradaTemp >> 8) & 0xFF;

    const a = (c.activeTimeModo1 >>> 0);
    pl[o++] = a & 0xFF; pl[o++] = (a >> 8) & 0xFF; pl[o++] = (a >> 16) & 0xFF; pl[o++] = (a >> 24) & 0xFF;

    return pl;
  }

  // ✅ Confirmación: esperar EVT_STATUS nuevo
  private async confirmConfigApplied(desired: ReturnType<BluetoothService['snapshotConfig']>, timeoutMs = 2000): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      const prev = this.statusTick$.value;

      const sub = this.statusTick$.subscribe(v => {
        if (v !== prev) {
          clearTimeout(t);
          sub.unsubscribe();

          const got = this.snapshotConfig();
          const same =
            got.mode === desired.mode &&
            got.thresholdCm === desired.thresholdCm &&
            got.hysteresisCm === desired.hysteresisCm &&
            got.retardoEntradaDist === desired.retardoEntradaDist &&
            got.retardoSalidaDist === desired.retardoSalidaDist &&
            got.retardoEntradaTemp === desired.retardoEntradaTemp &&
            got.activeTimeModo1 === desired.activeTimeModo1;

          if (!same) reject(new Error('CONFIG_MISMATCH'));
          else resolve();
        }
      });

      const t = setTimeout(() => {
        sub.unsubscribe();
        reject('STATUS timeout');
      }, timeoutMs);

      try {
        await this.requestStatus();
      } catch (e) {
        clearTimeout(t);
        sub.unsubscribe();
        reject(e);
      }
    });
  }

  // ✅ Envío final de config (pausa heartbeat para evitar CRC_ERR)
  private async flushConfig(): Promise<void> {
    if (!this.isConnected$.value || this.cfgInFlight || !this.cfgDirty) return;

    this.cfgInFlight = true;
    this.cfgDirty = false;

    const desired = this.snapshotConfig();
    this.validateConfig(desired);

    this.stopHeartbeat();
    try {
      const pl = this.buildConfigPayload(desired);
      await this.sendCmd(this.CMD_SET_CONFIG, pl, 3000);
      await this.confirmConfigApplied(desired, 2000);
    } finally {
      this.cfgInFlight = false;
      this.startHeartbeat();
      if (this.cfgDirty) this.flushConfig().catch(() => {});
    }
  }

  // ================================================================
  // 🌐 API PÚBLICA
  // ================================================================
  requestStatus() {
    return this.sendCmd(this.CMD_GET_STATUS);
  }

  requestRelayStats() {
    return this.sendCmd(this.CMD_GET_RELAYSTAT);
  }

  async resetRelayStats(): Promise<void> {
    await this.sendCmd(this.CMD_RESET_RELAYSTAT);

    // UI optimista
    this.zone.run(() => {
      this.relayLeftTimeMs$.next(0);
      this.relayLeftActivations$.next(0);
      this.relayRightTimeMs$.next(0);
      this.relayRightActivations$.next(0);
      this.relayStats$.next({
        L: { timeMs: 0, activations: 0 },
        R: { timeMs: 0, activations: 0 },
      });
    });
  }

  ping() {
    return this.sendCmd(this.CMD_PING, undefined, 3000);
  }

  applyConfig(): Promise<void> {
    this.cfgDirty = true;
    if (this.cfgTimer) clearTimeout(this.cfgTimer);
    return this.flushConfig();
  }

  applyConfigOnce(cfg: {
    mode: 0 | 1;
    thresholdCm: number;
    hysteresisCm: number;
    retardoEntradaDist: number;
    retardoSalidaDist: number;
    retardoEntradaTemp: number;
    activeTimeModo1: number;
  }) {
    this.mode$.next(cfg.mode);
    this.thresholdCm$.next(Math.round(cfg.thresholdCm));
    this.hysteresisCm$.next(Math.round(cfg.hysteresisCm));
    this.retardoEntradaDist$.next(Math.round(cfg.retardoEntradaDist));
    this.retardoSalidaDist$.next(Math.round(cfg.retardoSalidaDist));
    this.retardoEntradaTemp$.next(Math.round(cfg.retardoEntradaTemp));
    this.activeTimeModo1$.next(Math.round(cfg.activeTimeModo1));
    return this.applyConfig();
  }

  setThresholdCm(v: number) {
    const clamped = Math.max(5, Math.min(300, Math.round(v)));
    this.thresholdCm$.next(clamped);
    this.scheduleConfigSend();
  }

  setHysteresisCm(v: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    this.hysteresisCm$.next(clamped);
    this.scheduleConfigSend();
  }

  setRetardoEntradaDist(v: number) {
    const clamped = Math.max(0, Math.min(60000, Math.round(v)));
    this.retardoEntradaDist$.next(clamped);
    this.scheduleConfigSend();
  }

  setRetardoSalidaDist(v: number) {
    const clamped = Math.max(0, Math.min(60000, Math.round(v)));
    this.retardoSalidaDist$.next(clamped);
    this.scheduleConfigSend();
  }

  setMode(v: 0 | 1) {
    this.mode$.next(v);
    this.scheduleConfigSend();
  }

  setRetardoEntradaTemp(v: number) {
    const clamped = Math.max(0, Math.min(60000, Math.round(v)));
    this.retardoEntradaTemp$.next(clamped);
    this.scheduleConfigSend();
  }

  setActiveTimeModo1(v: number) {
    const clamped = Math.max(0, Math.min(600000, Math.round(v)));
    this.activeTimeModo1$.next(clamped);
    this.scheduleConfigSend();
  }

  setSideEnabled(side: 'L' | 'R', enabled: boolean) {
    if (side === 'L') this.enabledLeft$.next(enabled);
    if (side === 'R') this.enabledRight$.next(enabled);

    const pl = new Uint8Array(2);
    pl[0] = side.charCodeAt(0) & 0xFF;
    pl[1] = enabled ? 1 : 0;

    return this.sendCmd(this.CMD_SET_ENABLE, pl, 3000);
  }

  // Solo-app
  setLitersPerMin(v: number) { this.litersPerMin$.next(v); }
  setNumApplicators(v: number) { this.numApplicators$.next(v); }
  setGrPerSec(v: number) { this.grPerSec$.next(v); }

  // ✅ Simulación modo 1 (botones)
  async testTrigger(side: 'L' | 'R'): Promise<void> {
    const pl = new Uint8Array(1);
    pl[0] = side.charCodeAt(0) & 0xFF;
    await this.sendCmd(this.CMD_TEST_TRIGGER, pl, 3000);
  }

  // ✅ STOP emergencia
  async emergencyStop(): Promise<void> {
    await this.sendCmd(this.CMD_EMERGENCY_STOP, undefined, 3000);
    this.zone.run(() => {
      this.relayLeft$.next(false);
      this.relayRight$.next(false);
    });
  }
}
