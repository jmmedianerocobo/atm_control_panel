import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subscription, interval } from 'rxjs';
import { shareReplay } from 'rxjs/operators';

declare var bluetoothSerial: any;

export interface DistanceTracking {
  isBelowThreshold: boolean;
  activationCount: number;
  timeInMilliseconds: number;
}

export interface DistanceStats {
  left: DistanceTracking;
  right: DistanceTracking;
  dataReceivedCount: number;
  totalUptimeMs: number;
}

export interface BluetoothDevice {
  id: string;
  name: string;
  address: string;
  rssi?: number;
  class?: number;
}

@Injectable({
  providedIn: 'root',
})
export class BluetoothService {
  
  public distanceLeftSubject = new BehaviorSubject<number | null>(null);
  public distanceLeft$ = this.distanceLeftSubject.asObservable().pipe(shareReplay(1));
  
  public distanceRightSubject = new BehaviorSubject<number | null>(null);
  public distanceRight$ = this.distanceRightSubject.asObservable().pipe(shareReplay(1));

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

  private logsSubject = new BehaviorSubject<string[]>([]);
  public logs$ = this.logsSubject.asObservable();

  public isSimulationEnabledSubject = new BehaviorSubject<boolean>(false);
  public isSimulationEnabled$ = this.isSimulationEnabledSubject.asObservable().pipe(shareReplay(1));

  private readonly DEFAULT_THRESHOLD = 30; // ✅ CORREGIDO: 30cm como en la UI
  private configurableThresholdSubject = new BehaviorSubject<number>(this.DEFAULT_THRESHOLD);
  public configurableThreshold$ = this.configurableThresholdSubject.asObservable();

  // ✅ Filtrado optimizado
  private readonly EMA_ALPHA = 0.8; 
  private readonly MIN_CHANGE_CM = 2;
  
  private emaValueLeft: number | null = null;
  private emaValueRight: number | null = null;
  
  private lastReportedDistanceLeft: number | null = null;
  private lastReportedDistanceRight: number | null = null;

  private debugMode: boolean = true;
  private dataReceivedCount: number = 0;
  private currentDeviceId: string | null = null;
  
  private simulationSubscription?: Subscription;
  private statsUpdateSubscription?: Subscription;
  private readonly SIMULATION_INTERVAL_MS = 500;
  private readonly STATS_INTERVAL_MS = 200;

  private trackingStatsLeft: DistanceTracking = { isBelowThreshold: false, activationCount: 0, timeInMilliseconds: 0 };
  private trackingStatsRight: DistanceTracking = { isBelowThreshold: false, activationCount: 0, timeInMilliseconds: 0 };
  private lastTrackingUpdateTimestamp: number = Date.now();
  
  public leftDistanceCm$ = this.distanceLeft$;
  public rightDistanceCm$ = this.distanceRight$;

  // ✅ NUEVO: Estados de relés (sincronizados con Arduino)
  public relayLeftStateSubject = new BehaviorSubject<boolean>(false);
  public relayLeftState$ = this.relayLeftStateSubject.asObservable();
  
  public relayRightStateSubject = new BehaviorSubject<boolean>(false);
  public relayRightState$ = this.relayRightStateSubject.asObservable();

  constructor(private ngZone: NgZone) {
    console.log('%c[BT Service] 🚀 SISTEMA ESCLAVO v5.0', 'background: #007bff; color: white; font-size: 16px; font-weight: bold');
    this.addLog('🚀 Servicio ESCLAVO inicializado v5.0 - Control desde Angular');
    (window as any).btService = this;
    this.checkConnectionAndReconnect();

    this.statsUpdateSubscription = interval(this.STATS_INTERVAL_MS).subscribe(() => this.updateTimeTracking());
  }

  public getStats(): DistanceStats {
    return {
      left: { ...this.trackingStatsLeft },
      right: { ...this.trackingStatsRight },
      dataReceivedCount: this.dataReceivedCount,
      totalUptimeMs: Date.now() - this.lastTrackingUpdateTimestamp,
    };
  }

  public async sendCommand(command: string): Promise<void> {
    if (typeof bluetoothSerial === 'undefined') {
      console.log(`%c[BT TX] SIMULADO: "${command}"`, 'background: #FF9800; color: black; padding: 2px 6px; font-weight: bold');
      this.addLog(`[TX] SIMULADO: ${command}`);
      return; 
    }

    if (!this.isConnectedSubject.value) {
      this.addLog('⚠️ Error TX: No hay conexión activa');
      throw new Error('No hay conexión activa');
    }

    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.write(
          `${command}\n`,
          () => resolve(),
          (error: any) => reject(error)
        );
      });
      console.log(`%c[BT TX] "${command}"`, 'background: #9C27B0; color: white; padding: 2px 6px; font-weight: bold');
      this.addLog(`[TX] Comando enviado: ${command}`);
    } catch (error) {
      console.error(`%c[BT TX ERROR]`, 'background: #f44336; color: white; padding: 2px 6px; font-weight: bold', error);
      this.addLog(`❌ Error TX: ${error}`);
      throw error;
    }
  }
  
  // ========================================
  // ✅ MÉTODOS DE CONTROL DE RELÉ SIMPLIFICADOS
  // ========================================

  public activateLeft(): Promise<void> {
    return this.sendCommand('activateLeft');
  }

  public deactivateLeft(): Promise<void> {
    return this.sendCommand('deactivateLeft');
  }

  public activateRight(): Promise<void> {
    return this.sendCommand('activateRight');
  }

  public deactivateRight(): Promise<void> {
    return this.sendCommand('deactivateRight');
  }

  // ========================================
  // ✅ MÉTODOS DE INFORMACIÓN
  // ========================================

  public requestStats(): Promise<void> {
    return this.sendCommand('STATS');
  }

  public resetArduinoFilters(): Promise<void> {
    return this.sendCommand('RESET_FILTER');
  }

  public requestStatus(): Promise<void> {
    return this.sendCommand('STATUS');
  }

  // ========================================
  // MÉTODOS DE ESCANEO Y CONEXIÓN
  // ========================================
  
  public async scanForUnpaired(): Promise<void> {
    if (typeof bluetoothSerial === 'undefined') {
      this.addLog('[SCAN] SIMULADO: Fin de escaneo (sin plugin)');
      return;
    }

    this.ngZone.run(() => {
      this.isScanningSubject.next(true);
      this.unpairedDevicesSubject.next([]);
      this.addLog('[SCAN] Iniciando escaneo...');
    });

    try {
      const devices: any[] = await new Promise((resolve, reject) => {
        bluetoothSerial.discoverUnpaired(
          (deviceList: any[]) => resolve(deviceList),
          (error: any) => reject(error)
        );
      });

      const mappedDevices: BluetoothDevice[] = devices.map(d => ({
        id: d.address,
        name: d.name,
        address: d.address,
        rssi: d.rssi,
        class: d.class
      }));

      this.ngZone.run(() => {
        this.unpairedDevicesSubject.next(mappedDevices);
        this.addLog(`✅ Escaneo completado. Encontrados ${mappedDevices.length} dispositivos`);
      });

    } catch (error) {
      this.ngZone.run(() => {
        this.addLog(`❌ Error durante el escaneo: ${error}`);
      });
    } finally {
      this.ngZone.run(() => this.isScanningSubject.next(false));
    }
  }

  public toggleSimulationMode(enable: boolean): void {
    this.ngZone.run(() => {
      if (this.isConnectedSubject.value || this.isScanningSubject.value) {
        this.addLog('⚠️ No se puede cambiar simulación mientras está conectado/escaneando');
        return;
      }
      this.isSimulationEnabledSubject.next(enable);
      this.addLog(`[CONFIG] Simulación ${enable ? 'ON' : 'OFF'}`);

      if (enable) {
        this.resetFiltersAndStats();
        this.startSimulation();
      } else {
        this.stopSimulation();
      }
    });
  }

  private resetFiltersAndStats(): void {
    this.emaValueLeft = this.emaValueRight = null;
    this.lastReportedDistanceLeft = this.lastReportedDistanceRight = null;
    this.dataReceivedCount = 0;
    this.distanceLeftSubject.next(null);
    this.distanceRightSubject.next(null);
    this.relayLeftStateSubject.next(false);
    this.relayRightStateSubject.next(false);
    this.resetDistanceTracking();
    this.addLog('🔄 Filtros y estadísticas reseteados');
  }

  public resetDistanceTracking(): void {
    this.ngZone.run(() => {
      this.trackingStatsLeft = { isBelowThreshold: false, activationCount: 0, timeInMilliseconds: 0 };
      this.trackingStatsRight = { isBelowThreshold: false, activationCount: 0, timeInMilliseconds: 0 };
      this.lastTrackingUpdateTimestamp = Date.now();
      this.addLog('📊 Estadísticas de tracking reseteadas.');
    });
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
        this.addLog(`✅ ${mappedDevices.length} dispositivo(s) emparejado(s) encontrado(s)`);
      });
      return mappedDevices;

    } catch (error) {
      this.ngZone.run(() => this.pairedDevicesSubject.next([]));
      return [];
    }
  }

  public async connect(deviceAddress: string): Promise<void> {
    if (typeof bluetoothSerial === 'undefined' || this.isConnectedSubject.value) return;

    const isEnabled = await this.isBluetoothEnabled();
    if (!isEnabled) {
      throw new Error('Bluetooth_Disabled');
    }

    this.addLog(`🔗 Conectando a ${deviceAddress}...`);
    this.resetFiltersAndStats();

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
              this.addLog(`✓ Conectado a ${deviceAddress}`);
              this.addLog('ℹ️ Arduino en modo ESCLAVO - control desde Angular');
              this.stopSimulation();
              this.subscribeToData();
              resolve();
            });
          },
          (error: any) => {
            this.addLog(`❌ Error conectando: ${error}`);
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
    this.resetFiltersAndStats();
    this.stopSimulation();

    this.ngZone.run(() => {
      this.isConnectedSubject.next(false);
      this.connectedDeviceSubject.next(null);
      this.distanceLeftSubject.next(null);
      this.distanceRightSubject.next(null);
      this.relayLeftStateSubject.next(false);
      this.relayRightStateSubject.next(false);
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

  // ========================================
  // PROCESAMIENTO DE DATOS BLUETOOTH
  // ========================================
  
  private subscribeToData(): void {
    if (typeof bluetoothSerial === 'undefined') return;

    bluetoothSerial.subscribe('\n',
      (data: string) => {
        this.dataReceivedCount++;
        this.ngZone.run(() => {
          console.group(`%c📩 RX #${this.dataReceivedCount}`, 'background: #4CAF50; color: white; padding: 2px 8px; font-weight: bold; font-size: 12px');
          console.log(`Datos:      "${data.trim()}"`);
          console.log(`Timestamp:  ${new Date().toLocaleTimeString()}.${new Date().getMilliseconds()}`);
          console.groupEnd();
          
          this.addLog(`📩 #${this.dataReceivedCount}: "${data.trim()}"`);
          this.handleIncomingData(data);
        });
      },
      (error: any) => {
        this.ngZone.run(() => {
          console.error(`%c❌ BT ERROR`, 'background: #f44336; color: white; padding: 2px 8px; font-weight: bold', error);
          this.addLog(`❌ Error suscripción: ${JSON.stringify(error)}`);
          this.isConnectedSubject.next(false);
          this.connectedDeviceSubject.next(null);
          this.distanceLeftSubject.next(null);
          this.distanceRightSubject.next(null);
          this.relayLeftStateSubject.next(false);
          this.relayRightStateSubject.next(false);
        });
      }
    );
    
    console.log('%c[BT Service] 🎧 Suscrito a datos - Esperando...', 'background: #2196F3; color: white; padding: 4px 8px; font-weight: bold');
    this.addLog('🎧 Suscrito a datos del Arduino');
  }

  public unsubscribeData(): void {
    if (typeof bluetoothSerial !== 'undefined' && bluetoothSerial.unsubscribe) {
      bluetoothSerial.unsubscribe(
        () => this.addLog('🚫 Suscripción cancelada'),
        (error: any) => console.error('Error cancelando:', error)
      );
    }
  }

  private handleIncomingData(rawData: string): void {
    const cleanData = rawData.trim();
    const parts = cleanData.split(':');
    
    if (parts.length === 0) return;
    
    const messageType = parts[0].toUpperCase();
    
    switch (messageType) {
      case 'LOG':
        this.handleLogMessage(parts);
        break;
      case 'ACK':
        this.handleAckMessage(parts);
        break;
      case 'STATS':
        this.handleStatsMessage(cleanData);
        break;
      case 'STATUS':
        this.handleStatusMessage(parts);
        break;
      case 'ERROR':
        this.handleErrorMessage(parts);
        break;
      default:
        console.log(`%c[BT] Mensaje desconocido`, 'background: #607D8B; color: white; padding: 2px 6px', cleanData);
        this.addLog(`[RX-Unknown] ${cleanData}`);
    }
  }

  // ✅ Formato nuevo: LOG:LEFT:150 o LOG:RIGHT:200
  private handleLogMessage(parts: string[]): void {
    if (parts.length < 3) return;
    
    const side = parts[1].toUpperCase();
    const rawDistance = parseInt(parts[2], 10);
    
    console.log(`%c[BT] LOG`, 'background: #00BCD4; color: black; padding: 2px 6px',
                `${side}: ${rawDistance}cm`);
    
    if ((side === 'LEFT' || side === 'RIGHT') && !isNaN(rawDistance) && rawDistance >= 0 && rawDistance <= 600) {
      this.processSensorDistance(rawDistance, side);
      this.addLog(`[RX-${side}] ${rawDistance}cm`);
    }
  }

  // ✅ NUEVO: Procesar confirmaciones ACK:LEFT:ON, ACK:RIGHT:OFF, etc.
  private handleAckMessage(parts: string[]): void {
    if (parts.length < 3) return;
    
    const side = parts[1].toUpperCase();
    const state = parts[2].toUpperCase();
    
    console.log(`%c[BT] ACK`, 'background: #4CAF50; color: white; padding: 2px 6px',
                `${side}: ${state}`);
    
    if (side === 'LEFT') {
      this.relayLeftStateSubject.next(state === 'ON');
      this.addLog(`✅ ACK: Relé LEFT ${state}`);
    } else if (side === 'RIGHT') {
      this.relayRightStateSubject.next(state === 'ON');
      this.addLog(`✅ ACK: Relé RIGHT ${state}`);
    } else if (side === 'RESET_FILTER') {
      this.addLog(`✅ ACK: Filtros reseteados`);
    }
  }

  private handleStatsMessage(data: string): void {
    console.log(`%c[BT] STATS`, 'background: #9C27B0; color: white; padding: 2px 6px', data);
    this.addLog(`📊 ${data}`);
  }

  private handleStatusMessage(parts: string[]): void {
    console.log(`%c[BT] STATUS`, 'background: #2196F3; color: white; padding: 2px 6px', parts.join(':'));
    this.addLog(`ℹ️ STATUS: ${parts.slice(1).join(':')}`);
  }

  private handleErrorMessage(parts: string[]): void {
    const errorMsg = parts.slice(1).join(':');
    console.error(`%c[BT] ERROR`, 'background: #f44336; color: white; padding: 2px 6px', errorMsg);
    this.addLog(`❌ ERROR: ${errorMsg}`);
  }

  private processSensorDistance(rawDistance: number, side: 'LEFT' | 'RIGHT'): void {
    const smoothedDistance = this.applyEMAFilter(rawDistance, side);
    
    console.log(`%c[Filtro] ${side}`, 'background: #9C27B0; color: white; padding: 2px 6px',
                `Raw: ${rawDistance}cm → Suavizado: ${smoothedDistance}cm`);
    
    if (this.shouldUpdateDistance(smoothedDistance, side)) {
      if (side === 'LEFT') {
        this.distanceLeftSubject.next(smoothedDistance);
        this.lastReportedDistanceLeft = smoothedDistance;
        console.log(`%c[UI] LEFT actualizado`, 'background: #4CAF50; color: white; padding: 2px 6px', `${smoothedDistance}cm`);
      } else {
        this.distanceRightSubject.next(smoothedDistance);
        this.lastReportedDistanceRight = smoothedDistance;
        console.log(`%c[UI] RIGHT actualizado`, 'background: #4CAF50; color: white; padding: 2px 6px', `${smoothedDistance}cm`);
      }
      
      this.updateActivationTracking(smoothedDistance, side);
    } else {
      console.log(`%c[Filtro] ${side} ignorado`, 'background: #9E9E9E; color: white; padding: 2px 6px', 
                  `Cambio < ${this.MIN_CHANGE_CM}cm`);
    }
  }

  private applyEMAFilter(newValue: number, side: 'LEFT' | 'RIGHT'): number {
    let emaValue: number | null = (side === 'LEFT' ? this.emaValueLeft : this.emaValueRight);
    
    if (emaValue === null) {
      emaValue = newValue;
    } else {
      emaValue = this.EMA_ALPHA * newValue + (1 - this.EMA_ALPHA) * emaValue;
    }
    
    if (side === 'LEFT') {
      this.emaValueLeft = emaValue;
    } else {
      this.emaValueRight = emaValue;
    }
    
    return Math.round(emaValue);
  }

  private shouldUpdateDistance(newDistance: number, side: 'LEFT' | 'RIGHT'): boolean {
    const lastReported = (side === 'LEFT' ? this.lastReportedDistanceLeft : this.lastReportedDistanceRight);
    
    if (lastReported === null) {
      return true;
    }
    
    const change = Math.abs(newDistance - lastReported);
    return change >= this.MIN_CHANGE_CM;
  }

  private updateActivationTracking(distance: number, side: 'LEFT' | 'RIGHT'): void {
    const currentThreshold = this.configurableThresholdSubject.value;
    const isBelow = distance <= currentThreshold;
    
    let stats = side === 'LEFT' ? this.trackingStatsLeft : this.trackingStatsRight;
    
    if (isBelow && !stats.isBelowThreshold) {
      stats.activationCount++;
    }
    
    stats.isBelowThreshold = isBelow;
  }

  private updateTimeTracking(): void {
    const now = Date.now();
    const elapsed = now - this.lastTrackingUpdateTimestamp;
    this.lastTrackingUpdateTimestamp = now;

    const currentThreshold = this.configurableThresholdSubject.value;
    const distanceLeft = this.distanceLeftSubject.value;
    const distanceRight = this.distanceRightSubject.value;

    const updateSideTime = (stats: DistanceTracking, distance: number | null): DistanceTracking => {
      if (distance !== null && distance <= currentThreshold) {
        stats.timeInMilliseconds += elapsed;
      }
      return stats;
    };

    this.trackingStatsLeft = updateSideTime(this.trackingStatsLeft, distanceLeft);
    this.trackingStatsRight = updateSideTime(this.trackingStatsRight, distanceRight);
  }

  // ========================================
  // MODO SIMULACIÓN
  // ========================================
  
  private startSimulation(): void {
    this.stopSimulation();
    
    let simDistanceLeft = 120;
    let simDistanceRight = 30;

    this.simulationSubscription = interval(this.SIMULATION_INTERVAL_MS).subscribe(() => {
      this.ngZone.run(() => {
        if (!this.isSimulationEnabledSubject.value) {
          this.stopSimulation();
          return;
        }

        simDistanceLeft = Math.max(10, Math.min(300, simDistanceLeft + (Math.random() > 0.5 ? 2 : -2)));
        simDistanceRight = Math.max(10, Math.min(300, simDistanceRight + (Math.random() > 0.5 ? 1 : -1)));

        this.processSensorDistance(simDistanceLeft, 'LEFT');
        this.processSensorDistance(simDistanceRight, 'RIGHT');
      });
    });
    console.log('%c[Simulación] ▶️ Iniciada', 'background: #FF9800; color: black; padding: 4px 8px; font-weight: bold');
    this.addLog('▶️ Simulación iniciada.');
  }

  private stopSimulation(): void {
    if (this.simulationSubscription) {
      this.simulationSubscription.unsubscribe();
      this.simulationSubscription = undefined;
      console.log('%c[Simulación] ⏸️ Detenida', 'background: #607D8B; color: white; padding: 4px 8px; font-weight: bold');
      this.addLog('⏸️ Simulación detenida.');
    }
  }

  // ========================================
  // UTILIDADES
  // ========================================
  
  public async isBluetoothEnabled(): Promise<boolean> {
    if (typeof bluetoothSerial === 'undefined') return true;
    
    try {
      return await new Promise<boolean>((resolve) => {
        bluetoothSerial.isEnabled(() => resolve(true), () => resolve(false));
      });
    } catch (e) {
      return false;
    }
  }
  
  public async checkConnectionAndReconnect(): Promise<void> {
    if (typeof bluetoothSerial === 'undefined' || this.isSimulationEnabledSubject.value) return;
    
    const isCurrentlyConnected = await new Promise<boolean>((resolve) => {
      bluetoothSerial.isConnected(() => resolve(true), () => resolve(false));
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

  public clearLogs(): void {
    this.ngZone.run(() => {
      this.logsSubject.next([]);
    });
  }
}