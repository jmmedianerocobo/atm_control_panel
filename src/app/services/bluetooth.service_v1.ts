import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subscription, interval, Observable } from 'rxjs';
import { shareReplay } from 'rxjs/operators';

// Declaración para el plugin Cordova/Capacitor Bluetooth Serial
declare var bluetoothSerial: any;
// Necesario para la página de configuración para manejar la UI de permisos
declare var cordova: any; 

// =================================================================
// INTERFACES (Mejor tenerlas en un archivo separado como 'interfaces.ts')
// =================================================================

export interface DistanceTracking {
  isBelowThreshold: boolean;
  activationCount: number;
  timeInMilliseconds: number;
}

export interface BluetoothDevice {
  id: string; // Usaremos el address como ID
  name: string;
  address: string;
  rssi?: number;
  class?: number;
}

// =================================================================
// SERVICIO
// =================================================================

@Injectable({
  providedIn: 'root',
})
export class BluetoothService {
  
  // =================================================================
  // PROPIEDADES REACTIVAS PÚBLICAS
  // =================================================================

  public isConnectedSubject = new BehaviorSubject<boolean>(false);
  public isConnected$ = this.isConnectedSubject.asObservable().pipe(shareReplay(1));

  // isScanningSubject se usa ahora para ESCANEO DE NO EMPAREJADOS
  public isScanningSubject = new BehaviorSubject<boolean>(false);
  public isScanning$ = this.isScanningSubject.asObservable().pipe(shareReplay(1));

  // Lista de dispositivos NO EMPAREJADOS (resultados del escaneo)
  public unpairedDevicesSubject = new BehaviorSubject<BluetoothDevice[]>([]);
  public unpairedDevices$ = this.unpairedDevicesSubject.asObservable();
  
  // Lista de dispositivos EMPAREJADOS (listados al inicio)
  public pairedDevicesSubject = new BehaviorSubject<BluetoothDevice[]>([]);
  public pairedDevices$ = this.pairedDevicesSubject.asObservable();

  public connectedDeviceSubject = new BehaviorSubject<BluetoothDevice | null>(null);
  public connectedDevice$ = this.connectedDeviceSubject.asObservable();

  public distanceCmSubject = new BehaviorSubject<number | null>(null);
  public distanceCm$ = this.distanceCmSubject.asObservable();

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

  private readonly DEFAULT_THRESHOLD = 30;
  private configurableThresholdSubject = new BehaviorSubject<number>(this.DEFAULT_THRESHOLD);
  public configurableThreshold$ = this.configurableThresholdSubject.asObservable();

  public retardoEntradaTemp$ = new BehaviorSubject<number>(0);     // retardo modo 1
  public activeTimeModo1$ = new BehaviorSubject<number>(2000);     // tiempo ON modo 1


  // =================================================================
  // PROPIEDADES INTERNAS
  // =================================================================
  
  private simulationSubscription?: Subscription;
  private readonly SIMULATION_INTERVAL_MS = 500;
  private currentDeviceId: string | null = null;
  private lastUpdateTimestamp: number | null = null;
  
  constructor(private ngZone: NgZone) {
    console.log('[BT Service] 🚀 Inicializado.');
    (window as any).btService = this;
  }
  
  // =================================================================
  // MÉTODOS PÚBLICOS DE CONFIGURACIÓN Y ESTADO
  // =================================================================

   
  
  public setDistanceThreshold(newThreshold: number): void {
    if (newThreshold > 0 && newThreshold !== this.configurableThresholdSubject.value) {
      this.ngZone.run(() => {
        this.configurableThresholdSubject.next(newThreshold);
        this.addLog(`[CONFIG] Umbral fijado en ${newThreshold} cm`);
      });
    }
  }

  toggleSimulationMode(enable: boolean): void {
    this.ngZone.run(() => {
      if (this.isConnectedSubject.value || this.isScanningSubject.value) {
        console.warn('[BT Service] ⚠️ No se puede cambiar simulación mientras está conectado/escaneando');
        return;
      }
      this.isSimulationEnabledSubject.next(enable);
      this.addLog(`[CONFIG] Simulación ${enable ? 'activada' : 'desactivada'}`);
      
      if (enable) {
        // Lógica de inicio de simulación aquí
      } else {
        // Lógica de detención de simulación aquí
      }
    });
  }

  private get isSimulationMode(): boolean {
    return this.isSimulationEnabledSubject.value;
  }
  
  // =================================================================
  // MÉTODOS DE BLUETOOTH SERIAL
  // =================================================================
  
  /**
   * Carga la lista de dispositivos emparejados.
   */
  public async loadPairedDevices(): Promise<BluetoothDevice[]> {
    if (typeof bluetoothSerial === 'undefined') {
        this.addLog('❌ Plugin no disponible.');
        return [];
    }

    this.addLog('🔍 Listando emparejados...');

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
            this.addLog(`✅ ${mappedDevices.length} emparejado(s) encontrado(s).`);
        });
        return mappedDevices;

    } catch (error) {
        this.addLog(`❌ Error listando emparejados: ${error}`);
        this.ngZone.run(() => this.pairedDevicesSubject.next([]));
        return [];
    }
  }

  /**
   * Inicia el escaneo de dispositivos NO emparejados (descubrimiento).
   * Requiere permisos de Ubicación (Android) y Bluetooth.
   */
  public async scanForUnpaired(): Promise<void> {
    if (typeof bluetoothSerial === 'undefined') {
        this.addLog('❌ Plugin Bluetooth no disponible.');
        return;
    }

    if (this.isScanningSubject.value) {
        this.addLog('⚠️ Ya se está escaneando.');
        return;
    }

    this.ngZone.run(() => {
        this.isScanningSubject.next(true); 
        this.unpairedDevicesSubject.next([]);
        this.addLog('🔍 Iniciando escaneo de dispositivos NO emparejados...');
    });

    try {
        const devices: BluetoothDevice[] = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                // Intentar detener el escaneo si hay timeout
                if (bluetoothSerial.stopScan) {
                    bluetoothSerial.stopScan();
                }
                reject('Timeout: Escaneo tardó más de 30 segundos. Posibles problemas de GPS/Permisos.');
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
            this.addLog(`✅ Escaneo completado. Encontrados ${uniqueDevices.length} dispositivos.`);
        });

    } catch (error: any) {
        this.addLog(`❌ Error escaneando: ${error}`);
        this.unpairedDevicesSubject.next([]);
    } finally {
        this.ngZone.run(() => {
            this.isScanningSubject.next(false);
        });
    }
  }

  /**
   * Intenta conectar a un dispositivo Bluetooth.
   */
  public async connect(deviceAddress: string): Promise<void> {
    if (typeof bluetoothSerial === 'undefined' || this.isConnectedSubject.value) return;

    this.addLog(`🔗 Conectando a ${deviceAddress}...`);

    try {
        await new Promise<void>((resolve, reject) => {
            bluetoothSerial.connect(
                deviceAddress,
                () => {
                    this.ngZone.run(() => {
                        this.isConnectedSubject.next(true);
                        // Idealmente, obtener info del dispositivo conectado aquí
                        this.connectedDeviceSubject.next({ id: deviceAddress, name: 'Desconocido', address: deviceAddress }); 
                        this.addLog(`✓ Conectado a ${deviceAddress}`);
                        // Suscripción de datos debe ir aquí
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
        });
        throw error; // Propagar el error al componente
    }
  }

  /**
   * Desconecta del dispositivo actual.
   */
  public async disconnect(): Promise<void> {
    if (typeof bluetoothSerial === 'undefined' || !this.isConnectedSubject.value) return;

    this.addLog('🔌 Desconectando...');

    try {
        await new Promise<void>((resolve, reject) => {
            bluetoothSerial.disconnect(
                () => {
                    this.ngZone.run(() => {
                        this.isConnectedSubject.next(false);
                        this.connectedDeviceSubject.next(null);
                        this.addLog('✓ Desconexión exitosa');
                        resolve();
                    });
                },
                (error: any) => {
                    this.addLog(`❌ Error desconectando: ${error}`);
                    reject(error);
                }
            );
        });
    } catch (error) {
        throw error;
    }
  }

  // Métodos de envío de datos, suscripción, etc., deberían ir aquí.

  public async sendCommand(data: string): Promise<void> {
    if (!this.isConnectedSubject.value || typeof bluetoothSerial === 'undefined') {
        this.addLog('⚠️ No conectado para enviar.');
        return;
    }

    const fullCommand = data.endsWith('\n') ? data : `${data}\n`;
    this.addLog(`[TX] Enviando: ${data}`);

    try {
        await new Promise<void>((resolve, reject) => {
            bluetoothSerial.write(
                fullCommand,
                () => resolve(),
                (error: any) => reject(error)
            );
        });
    } catch (error) {
        this.addLog(`❌ Error enviando: ${error}`);
        throw error;
    }
  }

  // =================================================================
  // LÓGICA DE TRACKING Y LOGS
  // =================================================================
  
  public updateDistanceTracking(distance: number | null, intervalMs: number): void {
    // ... (Tu lógica de tracking existente)
  }

  public resetDistanceTracking(): void {
    // ... (Tu lógica de reset existente)
  }

  private addLog(message: string): void {
    const now = new Date().toLocaleTimeString();
    const newLog = `${now} | ${message}`;
    
    // Usamos ngZone para asegurar que el componente que esté suscrito se actualice
    this.ngZone.run(() => {
        const currentLogs = this.logsSubject.value;
        const updatedLogs = [newLog, ...currentLogs].slice(0, 50); // Limitar logs
        this.logsSubject.next(updatedLogs);
    });
    
    console.log(`[BT Service Log] ${newLog}`);
  }

  
}