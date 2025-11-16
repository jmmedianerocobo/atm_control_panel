import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { shareReplay } from 'rxjs/operators';

declare var bluetoothSerial: any;

export interface DistanceTracking {
  isBelowThreshold: boolean;
  activationCount: number;
  timeInMilliseconds: number;
}

export interface BluetoothDevice {
  id: string;
  name: string;
  address: string;
  rssi?: number;
  class?: number;
}

enum BluetoothMessageType {
  CONTROL = 'CONTROL',
  DATA = 'DATA',
  ERROR = 'ERROR',
  UNKNOWN = 'UNKNOWN'
}

interface ParsedBluetoothMessage {
  type: BluetoothMessageType;
  raw: string;
  distance?: number;
  timestamp?: string;
  status?: string;
}

@Injectable({
  providedIn: 'root',
})
export class BluetoothService {
  
  public isConnectedSubject = new BehaviorSubject<boolean>(false);
  public isConnected$ = this.isConnectedSubject.asObservable().pipe(shareReplay(1));

  public isScanningSubject = new BehaviorSubject<boolean>(false);
  public isScanning$ = this.isScanningSubject.asObservable().pipe(shareReplay(1));

  public unpairedDevicesSubject = new BehaviorSubject<BluetoothDevice[]>([]);
  public unpairedDevices$ = this.unpairedDevicesSubject.asObservable();
  
  public pairedDevicesSubject = new BehaviorSubject<BluetoothDevice[]>([]);
  public pairedDevices$ = this.pairedDevicesSubject.asObservable();

  public connectedDeviceSubject = new BehaviorSubject<BluetoothDevice | null>(null);
  public connectedDevice$ = this.connectedDeviceSubject.asObservable();

  public distanceCmSubject = new BehaviorSubject<number | null>(null);
  public distanceCm$ = this.distanceCmSubject.asObservable().pipe(shareReplay(1));

  public distanceTrackingSubject = new BehaviorSubject<DistanceTracking>({
    isBelowThreshold: false,
    activationCount: 0,
    timeInMilliseconds: 0,
  });
  public distanceTracking$ = this.distanceTrackingSubject.asObservable();

  private logsSubject = new BehaviorSubject<string[]>([]);
  public logs$ = this.logsSubject.asObservable();

  public isSimulationEnabledSubject = new BehaviorSubject<boolean>(false);
  public isSimulationEnabled$ = this.isSimulationEnabledSubject.asObservable().pipe(shareReplay(1));

  private readonly DEFAULT_THRESHOLD = 100;
  private configurableThresholdSubject = new BehaviorSubject<number>(this.DEFAULT_THRESHOLD);
  public configurableThreshold$ = this.configurableThresholdSubject.asObservable();

  // ⚡ OPTIMIZADO PARA VELOCIDAD: Tu Arduino ya filtra mucho
  private readonly EMA_ALPHA = 0.8; // ⚡ Menos suavizado (más reactivo)
  private emaValue: number | null = null;
  private readonly MIN_CHANGE_CM = 0; // ⚡ Sin hysteresis (actualiza siempre)
  private lastReportedDistance: number | null = null;
  
  private debugMode: boolean = true;
  private dataReceivedCount: number = 0;
  
  private currentDeviceId: string | null = null;
  
  constructor(private ngZone: NgZone) {
    console.log('%c[BT Service] 🚀 OPTIMIZADO PARA ARDUINO HC-06', 'background: #4CAF50; color: white; font-size: 16px; font-weight: bold');
    this.addLog('🚀 Servicio inicializado');
    (window as any).btService = this;
    this.checkConnectionAndReconnect();
  }
  
  public setDistanceThreshold(newThreshold: number): void {
    if (newThreshold > 0 && newThreshold !== this.configurableThresholdSubject.value) {
      this.ngZone.run(() => {
        this.configurableThresholdSubject.next(newThreshold);
        this.addLog(`[CONFIG] Umbral: ${newThreshold}cm`);
      });
    }
  }

  toggleSimulationMode(enable: boolean): void {
    this.ngZone.run(() => {
      if (this.isConnectedSubject.value || this.isScanningSubject.value) {
        return;
      }
      this.isSimulationEnabledSubject.next(enable);
      this.addLog(`[CONFIG] Simulación ${enable ? 'ON' : 'OFF'}`);
    });
  }

  private get isSimulationMode(): boolean {
    return this.isSimulationEnabledSubject.value;
  }
  
  public async isBluetoothEnabled(): Promise<boolean> {
    if (typeof bluetoothSerial === 'undefined') {
      return true;
    }
    
    try {
      const isEnabled = await new Promise<boolean>((resolve) => {
        bluetoothSerial.isEnabled(
          () => resolve(true),
          () => resolve(false)
        );
      });
      return isEnabled;
    } catch (e) {
      return false;
    }
  }

  public async ensureBluetoothConnection(): Promise<void> {
    if (this.isSimulationMode) return;
    
    const isEnabled = await this.isBluetoothEnabled();
    if (!isEnabled) {
      throw new Error('Bluetooth_Disabled');
    }
    
    if (this.isConnectedSubject.value) return;
    
    if (this.currentDeviceId) {
      await this.connect(this.currentDeviceId);
    }
  }

  public async checkConnectionAndReconnect(): Promise<void> {
    if (typeof bluetoothSerial === 'undefined' || this.isSimulationMode) return;
    
    const isCurrentlyConnected = await new Promise<boolean>((resolve) => {
      bluetoothSerial.isConnected(
        () => resolve(true),
        () => resolve(false)
      );
    });

    this.ngZone.run(() => {
      this.isConnectedSubject.next(isCurrentlyConnected);
    });

    if (isCurrentlyConnected) {
      if (!this.connectedDeviceSubject.value && this.currentDeviceId) {
        this.connectedDeviceSubject.next({ 
          id: this.currentDeviceId, 
          name: 'Arduino HC-06', 
          address: this.currentDeviceId 
        });
        this.subscribeToData();
      }
    }
  }

  public async loadPairedDevices(): Promise<BluetoothDevice[]> {
    if (typeof bluetoothSerial === 'undefined') return [];
    
    const isEnabled = await this.isBluetoothEnabled();
    if (!isEnabled) return [];

    try {
      const devices: any[] = await new Promise((resolve, reject) => {
        bluetoothSerial.list(
          (deviceList: any[]) => resolve(deviceList),
          (error: any) => reject(error)
        );
      });

      const mappedDevices: BluetoothDevice[] = devices.map(d => ({
        id: d.address,
        name: d.name,
        address: d.address
      }));

      this.ngZone.run(() => {
        this.pairedDevicesSubject.next(mappedDevices);
        this.addLog(`✅ ${mappedDevices.length} dispositivo(s) encontrado(s)`);
      });
      return mappedDevices;

    } catch (error) {
      this.ngZone.run(() => this.pairedDevicesSubject.next([]));
      return [];
    }
  }

  public async scanForUnpaired(): Promise<void> {
    if (typeof bluetoothSerial === 'undefined') return;
    
    const isEnabled = await this.isBluetoothEnabled();
    if (!isEnabled) return;

    if (this.isScanningSubject.value) return;

    this.ngZone.run(() => {
      this.isScanningSubject.next(true);
      this.unpairedDevicesSubject.next([]);
    });

    try {
      const devices: BluetoothDevice[] = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (bluetoothSerial.stopScan) bluetoothSerial.stopScan();
          reject('Timeout');
        }, 30000);

        bluetoothSerial.discoverUnpaired(
          (list: any[]) => {
            clearTimeout(timeout);
            const mappedDevices: BluetoothDevice[] = list.map(d => ({
              id: d.address,
              name: d.name || 'Sin nombre',
              address: d.address,
              rssi: d.rssi,
              class: d.class
            }));
            resolve(mappedDevices);
          },
          (err: any) => {
            clearTimeout(timeout);
            reject(err);
          }
        );
      });

      this.ngZone.run(() => {
        const uniqueDevices = devices.filter((d, index, self) =>
          index === self.findIndex((t) => t.address === d.address)
        );
        this.unpairedDevicesSubject.next(uniqueDevices);
      });

    } catch (error: any) {
      this.unpairedDevicesSubject.next([]);
    } finally {
      this.ngZone.run(() => {
        this.isScanningSubject.next(false);
      });
    }
  }

  public async connect(deviceAddress: string): Promise<void> {
    if (typeof bluetoothSerial === 'undefined' || this.isConnectedSubject.value) return;

    const isEnabled = await this.isBluetoothEnabled();
    if (!isEnabled) {
      throw new Error('Bluetooth_Disabled');
    }

    this.addLog(`🔗 Conectando...`);
    this.resetFilters();

    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.connect(
          deviceAddress,
          () => {
            this.ngZone.run(() => {
              this.isConnectedSubject.next(true);
              this.currentDeviceId = deviceAddress;
              this.connectedDeviceSubject.next({ 
                id: deviceAddress, 
                name: 'Arduino HC-06', 
                address: deviceAddress 
              });
              this.addLog(`✓ Conectado`);
              this.subscribeToData();
              resolve();
            });
          },
          (error: any) => {
            this.addLog(`❌ Error: ${error}`);
            reject(error);
          }
        );
      });
    } catch (error) {
      this.ngZone.run(() => {
        this.isConnectedSubject.next(false);
        this.connectedDeviceSubject.next(null);
        if (this.currentDeviceId === deviceAddress) {
          this.currentDeviceId = null;
        }
      });
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (typeof bluetoothSerial === 'undefined') return;

    this.addLog('🔌 Desconectando...');
    this.unsubscribeData();
    this.resetFilters();

    this.ngZone.run(() => {
      this.isConnectedSubject.next(false);
      this.connectedDeviceSubject.next(null);
      this.distanceCmSubject.next(null);
      this.currentDeviceId = null;
    });

    try {
      await new Promise<void>((resolve) => {
        bluetoothSerial.disconnect(
          () => {
            this.addLog('✓ Desconectado');
            resolve();
          },
          () => resolve()
        );
      });
    } catch (error) {
      throw error;
    }
  }

  public async sendCommand(data: string): Promise<void> {
    if (!this.isConnectedSubject.value || typeof bluetoothSerial === 'undefined') {
      throw new Error('Not_Connected');
    }

    const fullCommand = data.endsWith('\n') ? data : `${data}\n`;
    this.addLog(`[TX] ${data}`);

    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.write(
          fullCommand,
          () => resolve(),
          (error: any) => reject(error)
        );
      });
    } catch (error) {
      this.addLog(`❌ Error: ${error}`);
      throw error;
    }
  }

  private subscribeToData(): void {
    if (typeof bluetoothSerial === 'undefined') return;

    bluetoothSerial.subscribe('\n',
      (data: string) => {
        this.dataReceivedCount++;
        this.ngZone.run(() => {
          this.handleIncomingData(data);
        });
      },
      (error: any) => {
        this.ngZone.run(() => {
          this.addLog(`❌ Error suscripción`);
          this.isConnectedSubject.next(false);
          this.connectedDeviceSubject.next(null);
          this.distanceCmSubject.next(null);
        });
      }
    );
    
    this.addLog('🎧 Suscrito a datos');
  }

  public unsubscribeData(): void {
    if (typeof bluetoothSerial !== 'undefined' && bluetoothSerial.unsubscribe) {
      bluetoothSerial.unsubscribe(
        () => this.addLog('🚫 Suscripción cancelada'),
        (error: any) => console.error('Error cancelando:', error)
      );
    }
  }

  private parseBluetoothMessage(rawData: string): ParsedBluetoothMessage {
    const cleanData = rawData.trim();
    
    // Mensajes de control del Arduino
    const controlPatterns = [
      'SISTEMA INICIADO', 'SISTEMA DETENIDO', 'FILTRO RESETEADO',
      'VALOR RECIBIDO', 'COMANDO NO RECONOCIDO', 'ESTADISTICAS'
    ];
    
    for (const pattern of controlPatterns) {
      if (cleanData.toUpperCase().includes(pattern)) {
        return {
          type: BluetoothMessageType.CONTROL,
          raw: cleanData
        };
      }
    }
    
    // Formato Arduino: LOG:contador:distancia:estado
    const parts = cleanData.split(':');
    
    if (parts.length >= 3 && parts[0].toUpperCase() === 'LOG') {
      const distance = parseInt(parts[2], 10);
      
      if (!isNaN(distance) && distance >= 0 && distance <= 600) {
        return {
          type: BluetoothMessageType.DATA,
          raw: cleanData,
          distance: distance,
          timestamp: parts[1],
          status: parts[3] || 'OK'
        };
      } else {
        return {
          type: BluetoothMessageType.ERROR,
          raw: cleanData
        };
      }
    }
    
    return {
      type: BluetoothMessageType.UNKNOWN,
      raw: cleanData
    };
  }

  private handleIncomingData(rawData: string): void {
    const message = this.parseBluetoothMessage(rawData);
    
    switch (message.type) {
      case BluetoothMessageType.CONTROL:
        this.addLog(`[RX] ${message.raw}`);
        break;
        
      case BluetoothMessageType.DATA:
        if (message.distance !== undefined) {
          this.processDistance(message.distance, message.status || 'OK');
        }
        break;
        
      case BluetoothMessageType.ERROR:
        this.addLog(`[RX] ❌ ${message.raw}`);
        break;
        
      case BluetoothMessageType.UNKNOWN:
        this.addLog(`[RX] ⚠️ ${message.raw}`);
        break;
    }
  }

  private processDistance(rawDistance: number, status: string): void {
    // ⚡ SIN FILTROS: Actualización inmediata (puede tener más ruido)
    this.distanceCmSubject.next(rawDistance);
    
    if (status === 'ALERTA') {
      this.addLog(`⚠️ ${rawDistance}cm - ALERTA`);
    }
  }

  private applyEMAFilter(newValue: number): number {
    if (this.emaValue === null) {
      this.emaValue = newValue;
      return newValue;
    }
    
    this.emaValue = this.EMA_ALPHA * newValue + (1 - this.EMA_ALPHA) * this.emaValue;
    return Math.round(this.emaValue);
  }

  private shouldUpdateDistance(newDistance: number): boolean {
    if (this.lastReportedDistance === null) return true;
    
    const change = Math.abs(newDistance - this.lastReportedDistance);
    return change >= this.MIN_CHANGE_CM;
  }

  private resetFilters(): void {
    this.emaValue = null;
    this.lastReportedDistance = null;
    this.dataReceivedCount = 0;
  }

  public updateDistanceTracking(distance: number | null, intervalMs: number): void {
    const threshold = this.configurableThresholdSubject.value;
    
    if (distance !== null && distance < threshold) {
      const current = this.distanceTrackingSubject.value;
      this.distanceTrackingSubject.next({
        isBelowThreshold: true,
        activationCount: current.isBelowThreshold ? current.activationCount : current.activationCount + 1,
        timeInMilliseconds: current.timeInMilliseconds + intervalMs
      });
    } else {
      const current = this.distanceTrackingSubject.value;
      if (current.isBelowThreshold) {
        this.distanceTrackingSubject.next({
          ...current,
          isBelowThreshold: false
        });
      }
    }
  }

  public resetDistanceTracking(): void {
    this.distanceTrackingSubject.next({
      isBelowThreshold: false,
      activationCount: 0,
      timeInMilliseconds: 0
    });
  }

  private addLog(message: string): void {
    if (!this.debugMode) return;
    
    const now = new Date().toLocaleTimeString();
    const newLog = `${now} | ${message}`;
    
    this.ngZone.run(() => {
      const currentLogs = this.logsSubject.value;
      const updatedLogs = [newLog, ...currentLogs].slice(0, 100);
      this.logsSubject.next(updatedLogs);
    });
  }

  public setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  public getStats(): any {
    return {
      isConnected: this.isConnectedSubject.value,
      currentDistance: this.distanceCmSubject.value,
      deviceId: this.currentDeviceId,
      dataReceivedCount: this.dataReceivedCount
    };
  }

  public clearLogs(): void {
    this.ngZone.run(() => {
      this.logsSubject.next([]);
    });
  }
}
