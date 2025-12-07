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

// ✅ MEJORADO: Prioridades de comandos
export enum CommandPriority {
  LOW = 0,      // STATS, STATUS
  NORMAL = 1,   // activateLeft, activateRight
  HIGH = 2      // deactivateLeft, deactivateRight (seguridad)
}

// ✅ MEJORADO: Interfaz para comandos en cola con prioridad
interface CommandQueueItem {
  command: string;
  resolve: (value: void) => void;
  reject: (reason?: any) => void;
  timestamp: number;
  retries: number;
  priority: CommandPriority;  // ✅ NUEVO
}

// ✅ NUEVO: Estadísticas de la cola
export interface QueueStats {
  currentSize: number;
  maxSizeReached: number;
  totalCommandsSent: number;
  totalAcksReceived: number;
  totalRetries: number;
  totalTimeouts: number;
  totalErrors: number;
  averageLatency: number;
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

  private readonly DEFAULT_THRESHOLD = 30;
  private configurableThresholdSubject = new BehaviorSubject<number>(this.DEFAULT_THRESHOLD);
  public configurableThreshold$ = this.configurableThresholdSubject.asObservable();

  private readonly EMA_ALPHA = 0.95; 
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

  public relayLeftStateSubject = new BehaviorSubject<boolean>(false);
  public relayLeftState$ = this.relayLeftStateSubject.asObservable();
  
  public relayRightStateSubject = new BehaviorSubject<boolean>(false);
  public relayRightState$ = this.relayRightStateSubject.asObservable();

  // ✅ MEJORADO: Sistema de cola de comandos con ACK y límites
  private commandQueue: CommandQueueItem[] = [];
  private isProcessingQueue = false;
  private currentCommand: CommandQueueItem | null = null;
  private ackTimer: any = null;
  
  // ✅ NUEVO: Límites y configuración
  private readonly MAX_QUEUE_SIZE = 50;          // ✅ Límite de cola
  private readonly MAX_COMMAND_LENGTH = 120;      // ✅ Longitud máxima de comando
  private readonly ACK_TIMEOUT_MS = 1000;         // 1 segundo
  private readonly MAX_RETRIES = 2;               // Máximo 2 reintentos

  // ✅ MEJORADO: Watchdog de conexión robusto
  private connectionWatchdog?: Subscription;
  private readonly WATCHDOG_INTERVAL_MS = 15000;  // ✅ Ping cada 15 segundos (antes: 3s)
  private readonly WATCHDOG_TIMEOUT_MS = 8000;    // ✅ Timeout de 8 segundos (antes: 2s)
  private readonly WATCHDOG_MAX_FAILURES = 3;     // ✅ NUEVO: Permitir 3 fallos consecutivos
  private watchdogFailureCount = 0;               // ✅ NUEVO: Contador de fallos

  // ✅ NUEVO: Estadísticas de la cola
  private queueStats: QueueStats = {
    currentSize: 0,
    maxSizeReached: 0,
    totalCommandsSent: 0,
    totalAcksReceived: 0,
    totalRetries: 0,
    totalTimeouts: 0,
    totalErrors: 0,
    averageLatency: 0
  };
  private latencyHistory: number[] = [];
  private readonly MAX_LATENCY_SAMPLES = 100;

  constructor(private ngZone: NgZone) {
    console.log('%c[BT Service] 🚀 SISTEMA MEJORADO v7.1 - WATCHDOG ROBUSTO', 'background: #007bff; color: white; font-size: 16px; font-weight: bold');
    this.addLog('🚀 Servicio v7.1 - Watchdog robusto implementado');
    this.addLog(`📊 Límites: Cola=${this.MAX_QUEUE_SIZE}, Comando=${this.MAX_COMMAND_LENGTH}bytes`);
    this.addLog(`🐕 Watchdog: Intervalo=${this.WATCHDOG_INTERVAL_MS/1000}s, Timeout=${this.WATCHDOG_TIMEOUT_MS/1000}s, MaxFallos=${this.WATCHDOG_MAX_FAILURES}`);
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

  // ✅ NUEVO: Obtener estadísticas de la cola
  public getQueueStats(): QueueStats {
    return { ...this.queueStats, currentSize: this.commandQueue.length };
  }

  // ✅ MEJORADO: sendCommand con validaciones y prioridades
  public async sendCommand(command: string, priority: CommandPriority = CommandPriority.NORMAL): Promise<void> {
    // ✅ NUEVO: Validar longitud del comando
    if (command.length > this.MAX_COMMAND_LENGTH) {
      const error = `Comando muy largo (${command.length}>${this.MAX_COMMAND_LENGTH} bytes)`;
      this.addLog(`❌ ${error}`);
      return Promise.reject(new Error(error));
    }

    // Modo simulación
    if (typeof bluetoothSerial === 'undefined') {
      console.log(`%c[BT TX] SIMULADO: "${command}"`, 'background: #FF9800; color: black; padding: 2px 6px; font-weight: bold');
      this.addLog(`[TX] SIMULADO: ${command}`);
      return Promise.resolve();
    }

    // Verificar conexión
    if (!this.isConnectedSubject.value) {
      this.addLog('⚠️ Error TX: No hay conexión activa');
      return Promise.reject(new Error('No hay conexión activa'));
    }

    // ✅ NUEVO: Verificar límite de cola
    if (this.commandQueue.length >= this.MAX_QUEUE_SIZE) {
      const error = `Cola llena (${this.commandQueue.length}/${this.MAX_QUEUE_SIZE} comandos)`;
      this.addLog(`❌ ${error}`);
      this.queueStats.totalErrors++;
      return Promise.reject(new Error(error));
    }

    // ✅ Añadir a la cola con prioridad
    return new Promise<void>((resolve, reject) => {
      const queueItem: CommandQueueItem = {
        command,
        resolve,
        reject,
        timestamp: Date.now(),
        retries: 0,
        priority  // ✅ NUEVO: Prioridad del comando
      };

      this.commandQueue.push(queueItem);
      
      // ✅ NUEVO: Ordenar por prioridad (HIGH > NORMAL > LOW)
      this.commandQueue.sort((a, b) => b.priority - a.priority);
      
      // ✅ NUEVO: Actualizar estadísticas
      this.queueStats.currentSize = this.commandQueue.length;
      if (this.commandQueue.length > this.queueStats.maxSizeReached) {
        this.queueStats.maxSizeReached = this.commandQueue.length;
      }

      console.log(`%c[Cola] Comando añadido: "${command}" (prioridad=${priority}, posición=${this.commandQueue.length})`, 
                  'background: #2196F3; color: white; padding: 2px 6px');
      
      // Si no estamos procesando, iniciar procesamiento
      if (!this.isProcessingQueue) {
        this.processNextCommand();
      }
    });
  }

  // ✅ MEJORADO: Procesar siguiente comando con mejor manejo de errores
  private async processNextCommand(): Promise<void> {
    // ✅ NUEVO: Verificar conexión antes de procesar
    if (!this.isConnectedSubject.value) {
      this.addLog('⚠️ Desconectado - vaciando cola');
      this.clearCommandQueue();
      return;
    }

    // Si ya está procesando o no hay comandos, salir
    if (this.isProcessingQueue || this.commandQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;
    this.currentCommand = this.commandQueue[0];

    console.log(`%c[Cola] Procesando: "${this.currentCommand.command}" (intento ${this.currentCommand.retries + 1}/${this.MAX_RETRIES + 1}, prioridad=${this.currentCommand.priority})`,
                'background: #9C27B0; color: white; padding: 2px 6px; font-weight: bold');

    const startTime = Date.now();

    try {
      // Enviar comando por Bluetooth
      await this.sendRawCommand(this.currentCommand.command);
      this.queueStats.totalCommandsSent++;

      // Esperar ACK con timeout
      const ackReceived = await this.waitForAck(this.currentCommand.command);

      if (ackReceived) {
        // ✅ ACK recibido - comando exitoso
        const latency = Date.now() - startTime;
        this.updateLatencyStats(latency);
        this.queueStats.totalAcksReceived++;

        console.log(`%c[Cola] ✅ Comando exitoso: "${this.currentCommand.command}" (${latency}ms)`,
                    'background: #4CAF50; color: white; padding: 2px 6px; font-weight: bold');
        this.currentCommand.resolve();
        this.commandQueue.shift();
        this.currentCommand = null;
      } else {
        // ⏱️ Timeout - intentar de nuevo
        this.currentCommand.retries++;
        this.queueStats.totalTimeouts++;
        
        if (this.currentCommand.retries <= this.MAX_RETRIES) {
          console.warn(`%c[Cola] ⏱️ Timeout - Reintentando (${this.currentCommand.retries}/${this.MAX_RETRIES})`,
                       'background: #FF9800; color: black; padding: 2px 6px');
          this.addLog(`⚠️ Timeout comando "${this.currentCommand.command}" - Reintento ${this.currentCommand.retries}`);
          this.queueStats.totalRetries++;
        } else {
          // ❌ Máximo de reintentos alcanzado
          console.error(`%c[Cola] ❌ Comando falló: "${this.currentCommand.command}"`,
                        'background: #f44336; color: white; padding: 2px 6px; font-weight: bold');
          this.addLog(`❌ Comando falló después de ${this.MAX_RETRIES} reintentos: "${this.currentCommand.command}"`);
          this.queueStats.totalErrors++;
          this.currentCommand.reject(new Error(`Timeout después de ${this.MAX_RETRIES} reintentos`));
          this.commandQueue.shift();
          this.currentCommand = null;
        }
      }
    } catch (error) {
      // Error enviando comando
      console.error(`%c[Cola] ❌ Error enviando comando`, 'background: #f44336; color: white; padding: 2px 6px', error);
      this.queueStats.totalErrors++;
      this.currentCommand!.reject(error);
      this.commandQueue.shift();
      this.currentCommand = null;
    }

    // Marcar como no procesando
    this.isProcessingQueue = false;

    // ✅ NUEVO: Actualizar tamaño actual de cola
    this.queueStats.currentSize = this.commandQueue.length;

    // Procesar siguiente comando (recursivo)
    if (this.commandQueue.length > 0) {
      // Pequeño delay para dar tiempo al Arduino
      setTimeout(() => this.processNextCommand(), 50);
    }
  }

  // ✅ NUEVO: Actualizar estadísticas de latencia
  private updateLatencyStats(latency: number): void {
    this.latencyHistory.push(latency);
    if (this.latencyHistory.length > this.MAX_LATENCY_SAMPLES) {
      this.latencyHistory.shift();
    }
    
    const sum = this.latencyHistory.reduce((a, b) => a + b, 0);
    this.queueStats.averageLatency = sum / this.latencyHistory.length;
  }

  // ✅ NUEVO: Limpiar cola de comandos
  private clearCommandQueue(): void {
    console.log(`%c[Cola] Limpiando ${this.commandQueue.length} comandos pendientes`, 
                'background: #FF5722; color: white; padding: 2px 6px; font-weight: bold');
    
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift()!;
      cmd.reject(new Error('Conexión perdida'));
    }
    
    if (this.currentCommand) {
      this.currentCommand.reject(new Error('Conexión perdida'));
      this.currentCommand = null;
    }
    
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    
    this.isProcessingQueue = false;
    this.queueStats.currentSize = 0;
    
    this.addLog('🧹 Cola de comandos limpiada');
  }

  // Enviar comando raw sin esperar ACK
  private async sendRawCommand(command: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      bluetoothSerial.write(
        `${command}\n`,
        () => {
          console.log(`%c[BT TX] "${command}"`, 'background: #9C27B0; color: white; padding: 2px 6px; font-weight: bold');
          this.addLog(`📤 [TX] ${command}`);
          resolve();
        },
        (error: any) => {
          console.error(`%c[BT TX ERROR]`, 'background: #f44336; color: white; padding: 2px 6px', error);
          this.addLog(`❌ Error TX: ${error}`);
          reject(error);
        }
      );
    });
  }

  // Esperar ACK con timeout
  private waitForAck(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const expectedAck = this.getExpectedAck(command);
      
      console.log(`%c[ACK] Esperando: "${expectedAck}"`, 'background: #00BCD4; color: black; padding: 2px 6px');

      // Configurar timeout
      this.ackTimer = setTimeout(() => {
        console.warn(`%c[ACK] ⏱️ Timeout esperando ACK`, 'background: #FF9800; color: black; padding: 2px 6px');
        resolve(false);
      }, this.ACK_TIMEOUT_MS);

      // El ACK se maneja en handleAckMessage()
      // que llamará a resolveAck() cuando llegue
    });
  }

  // Obtener ACK esperado para un comando
  private getExpectedAck(command: string): string {
    const ackMap: { [key: string]: string } = {
      'activateLeft': 'ACK:LEFT:ON',
      'deactivateLeft': 'ACK:LEFT:OFF',
      'activateRight': 'ACK:RIGHT:ON',
      'deactivateRight': 'ACK:RIGHT:OFF',
      'STATS': 'STATS:',
      'RESET_FILTER': 'ACK:RESET_FILTER:OK',
      'STATUS': 'STATUS:'
    };

    return ackMap[command] || '';
  }

  // Resolver ACK recibido
  private resolveAck(ackMessage: string): void {
    if (!this.currentCommand) return;

    const expectedAck = this.getExpectedAck(this.currentCommand.command);
    
    // Verificar que el ACK coincide
    if (ackMessage.startsWith(expectedAck) || ackMessage === expectedAck) {
      console.log(`%c[ACK] ✅ Recibido: "${ackMessage}"`, 'background: #4CAF50; color: white; padding: 2px 6px; font-weight: bold');
      
      // Cancelar timeout
      if (this.ackTimer) {
        clearTimeout(this.ackTimer);
        this.ackTimer = null;
      }

      // Marcar comando como exitoso
      // El procesamiento continúa en processNextCommand()
    }
  }
  
  // ✅ MEJORADO: Métodos de control con prioridades
  public activateLeft(): Promise<void> {
    return this.sendCommand('activateLeft', CommandPriority.NORMAL);
  }

  public deactivateLeft(): Promise<void> {
    return this.sendCommand('deactivateLeft', CommandPriority.HIGH);  // ✅ Alta prioridad (seguridad)
  }

  public activateRight(): Promise<void> {
    return this.sendCommand('activateRight', CommandPriority.NORMAL);
  }

  public deactivateRight(): Promise<void> {
    return this.sendCommand('deactivateRight', CommandPriority.HIGH);  // ✅ Alta prioridad (seguridad)
  }

  public requestStats(): Promise<void> {
    return this.sendCommand('STATS', CommandPriority.LOW);
  }

  public resetArduinoFilters(): Promise<void> {
    return this.sendCommand('RESET_FILTER', CommandPriority.NORMAL);
  }

  public requestStatus(): Promise<void> {
    return this.sendCommand('STATUS', CommandPriority.LOW);
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
    
    // ✅ Limpiar cola de comandos
    this.clearCommandQueue();
    
    this.addLog('🔄 Filtros, estadísticas y cola reseteados');
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
              this.addLog('ℹ️ Sistema mejorado v7.1 - Watchdog robusto activo');
              this.stopSimulation();
              this.subscribeToData();
              
              // ✅ NUEVO: Iniciar watchdog de conexión robusto
              //this.startConnectionWatchdog();
              
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
  
  // ✅ MEJORADO: disconnect con limpieza de cola
  public async disconnect(): Promise<void> {
    if (typeof bluetoothSerial === 'undefined') return;

    this.addLog('🔌 Desconectando...');
    
    // ✅ NUEVO: Detener watchdog
    this.stopConnectionWatchdog();
    
    this.unsubscribeData();
    
    // ✅ NUEVO: Limpiar cola de comandos pendientes
    this.clearCommandQueue();
    
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

  // ✅✅ MEJORADO: Watchdog de conexión ROBUSTO con tolerancia a fallos
  private startConnectionWatchdog(): void {
    this.stopConnectionWatchdog();
    this.watchdogFailureCount = 0;  // ✅ Reset contador al iniciar
    
    this.connectionWatchdog = interval(this.WATCHDOG_INTERVAL_MS).subscribe(async () => {
      if (!this.isConnectedSubject.value) {
        this.stopConnectionWatchdog();
        return;
      }
      
      try {
        // ✅ MEJORADO: STATUS con prioridad ALTA para no esperar en cola
        await Promise.race([
          this.sendCommand('STATUS', CommandPriority.HIGH),  // ← Prioridad ALTA (antes era LOW vía requestStatus())
          new Promise<void>((_, reject) => 
            setTimeout(() => reject(new Error('Watchdog timeout')), this.WATCHDOG_TIMEOUT_MS)
          )
        ]);
        
        // ✅ Éxito: resetear contador de fallos
        if (this.watchdogFailureCount > 0) {
          console.log(`%c[Watchdog] ✅ Recuperado (fallos: ${this.watchdogFailureCount} → 0)`, 
                      'background: #4CAF50; color: white; padding: 2px 6px; font-weight: bold');
          this.addLog(`✅ Watchdog: Conexión recuperada (${this.watchdogFailureCount} fallos resueltos)`);
        }
        this.watchdogFailureCount = 0;
        
      } catch (error) {
        // ⚠️ Fallo: incrementar contador
        this.watchdogFailureCount++;
        console.warn(`%c[Watchdog] ⚠️ Fallo ${this.watchdogFailureCount}/${this.WATCHDOG_MAX_FAILURES}`, 
                     'background: #FF9800; color: black; padding: 2px 6px; font-weight: bold', error);
        
        // ❌ Si supera máximo de fallos → desconectar
        if (this.watchdogFailureCount >= this.WATCHDOG_MAX_FAILURES) {
          console.error('%c[Watchdog] ❌ Máximo de fallos consecutivos alcanzado - Desconectando', 
                        'background: #f44336; color: white; padding: 2px 6px; font-weight: bold');
          this.addLog(`❌ Watchdog: ${this.WATCHDOG_MAX_FAILURES} fallos consecutivos - Forzando desconexión`);
          
          this.ngZone.run(() => {
            this.disconnect();
          });
        } else {
          this.addLog(`⚠️ Watchdog: Fallo ${this.watchdogFailureCount}/${this.WATCHDOG_MAX_FAILURES} - Reintentando en ${this.WATCHDOG_INTERVAL_MS/1000}s...`);
        }
      }
    });
    
    this.addLog(`🐕 Watchdog iniciado (intervalo=${this.WATCHDOG_INTERVAL_MS/1000}s, timeout=${this.WATCHDOG_TIMEOUT_MS/1000}s, max_fallos=${this.WATCHDOG_MAX_FAILURES})`);
  }

  private stopConnectionWatchdog(): void {
    if (this.connectionWatchdog) {
      this.connectionWatchdog.unsubscribe();
      this.connectionWatchdog = undefined;
      this.watchdogFailureCount = 0;  // ✅ Reset contador al detener
      this.addLog('🐕 Watchdog de conexión detenido');
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
          
          // ✅ NUEVO: Detener watchdog y limpiar cola
          this.stopConnectionWatchdog();
          this.clearCommandQueue();
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
        this.handleAckMessage(parts, cleanData);
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

  private handleAckMessage(parts: string[], fullMessage: string): void {
    if (parts.length < 3) return;
    
    const side = parts[1].toUpperCase();
    const state = parts[2].toUpperCase();
    
    console.log(`%c[BT] ACK`, 'background: #4CAF50; color: white; padding: 2px 6px',
                `${side}: ${state}`);
    
    // ✅ Resolver ACK pendiente
    this.resolveAck(fullMessage);
    
    // Actualizar estado de relés
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
    
    // ✅ Resolver ACK para STATS
    this.resolveAck(data);
  }

  private handleStatusMessage(parts: string[]): void {
    const fullMessage = parts.join(':');
    console.log(`%c[BT] STATUS`, 'background: #2196F3; color: white; padding: 2px 6px', fullMessage);
    this.addLog(`ℹ️ STATUS: ${parts.slice(1).join(':')}`);
    
    // ✅ Resolver ACK para STATUS
    this.resolveAck(fullMessage);
  }

  private handleErrorMessage(parts: string[]): void {
    const errorMsg = parts.slice(1).join(':');
    console.error(`%c[BT] ERROR`, 'background: #f44336; color: white; padding: 2px 6px', errorMsg);
    this.addLog(`❌ ERROR: ${errorMsg}`);
    
    // ✅ Si hay comando pendiente, marcarlo como fallido
    if (this.currentCommand && this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
      // El timeout se encargará de reintentar o fallar
    }
  }

  private processSensorDistance(rawDistance: number, side: 'LEFT' | 'RIGHT'): void {
    let smoothedDistance: number;
    
    if (side === 'LEFT') {
      smoothedDistance = this.applyEMAFilter(rawDistance, this.emaValueLeft);
      this.emaValueLeft = smoothedDistance;
    } else {
      smoothedDistance = this.applyEMAFilter(rawDistance, this.emaValueRight);
      this.emaValueRight = smoothedDistance;
    }
    
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

  private applyEMAFilter(newValue: number, lastValue: number | null): number {
    if (lastValue === null) {
      return newValue;
    }
    
    const diff = Math.abs(newValue - lastValue);
    if (diff > 100) {
      console.log(`%c[Filtro] Cambio grande detectado: ${diff}cm → Reseteando`, 'color: orange; font-weight: bold;');
      return newValue;
    }
    
    return (this.EMA_ALPHA * newValue) + ((1 - this.EMA_ALPHA) * lastValue);
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
        this.startConnectionWatchdog();  // ✅ Iniciar watchdog robusto
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

  // ✅ NUEVO: Método para obtener estado completo del sistema
  public getSystemStatus(): any {
    return {
      connection: {
        isConnected: this.isConnectedSubject.value,
        deviceId: this.currentDeviceId,
        deviceName: this.connectedDeviceSubject.value?.name || 'N/A'
      },
      queue: this.getQueueStats(),
      watchdog: {
        interval: this.WATCHDOG_INTERVAL_MS,
        timeout: this.WATCHDOG_TIMEOUT_MS,
        maxFailures: this.WATCHDOG_MAX_FAILURES,
        currentFailures: this.watchdogFailureCount
      },
      sensors: {
        left: {
          distance: this.distanceLeftSubject.value,
          relayActive: this.relayLeftStateSubject.value
        },
        right: {
          distance: this.distanceRightSubject.value,
          relayActive: this.relayRightStateSubject.value
        }
      },
      tracking: this.getStats(),
      configuration: {
        threshold: this.configurableThresholdSubject.value,
        maxQueueSize: this.MAX_QUEUE_SIZE,
        maxCommandLength: this.MAX_COMMAND_LENGTH,
        ackTimeout: this.ACK_TIMEOUT_MS,
        maxRetries: this.MAX_RETRIES
      }
    };
  }
}