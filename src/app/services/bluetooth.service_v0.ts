import { Injectable, NgZone } from '@angular/core';
import { Platform, AlertController } from '@ionic/angular';
import { BehaviorSubject, Observable, Subject, filter, map, shareReplay, throttleTime, tap } from 'rxjs';

declare var bluetoothSerial: any;
declare var cordova: any;

interface BluetoothDevice {
    name: string;
    address: string;
}

interface LogEntry {
    timestamp: Date;
    type: 'rx' | 'tx' | 'pairing' | 'connect' | 'disconnect' | 'info' | 'success' | 'error' | 'warning';
    message: string;
    bytes?: number;
}

interface Statistics {
    messagesSent: number;
    messagesReceived: number;
    bytesSent: number;
    bytesReceived: number;
    errors: number;
    connectionAttempts: number;
    successfulConnections: number;
    pairingAttempts: number;
    successfulPairings: number;
    connectionTime: Date | null;
    uptime: number;
    lastError: string | null;
    timeBelowThreshold: number;
}

@Injectable({
    providedIn: 'root'
})
export class BluetoothService {
    
    // Sujetos reactivos para el estado
    private isConnectedSubject = new BehaviorSubject<boolean>(false);
    isConnected$ = this.isConnectedSubject.asObservable();

    private connectedDeviceSubject = new BehaviorSubject<BluetoothDevice | null>(null);
    connectedDevice$ = this.connectedDeviceSubject.asObservable();

    private logsSubject = new BehaviorSubject<LogEntry[]>([]);
    logs$ = this.logsSubject.asObservable();

    // ✅ COMPATIBILIDAD: Mantener BehaviorSubject para rxData$
    // Subject crudo para procesamiento interno rápido
    public rawRxDataSubject = new Subject<string>();
    
    // BehaviorSubject para compatibilidad con home.page.ts
    private rxDataSubject = new BehaviorSubject<string>('');
    rxData$ = this.rxDataSubject.asObservable();

    private statisticsSubject = new BehaviorSubject<Statistics>({
        messagesSent: 0, messagesReceived: 0, bytesSent: 0, bytesReceived: 0,
        errors: 0, connectionAttempts: 0, successfulConnections: 0, pairingAttempts: 0,
        successfulPairings: 0, connectionTime: null, uptime: 0, lastError: null,
        timeBelowThreshold: 0
    });
    statistics$ = this.statisticsSubject.asObservable();
    
    // Observable throttled SOLO para la UI
    public distanceCm$!: Observable<number | null>;

    // Propiedades de Reconexión
    autoReconnect = true;
    isReconnecting = false;
    reconnectAttempts = 0;
    maxReconnectAttempts = 5;
    reconnectDelay = 3000;
    private reconnectTimer: any;
    private uptimeInterval: any;

    lastDeviceAddress: string | null = null;
    maxLogs = 300;

    // OPTIMIZACIÓN: Reducir throttle para UI
    private readonly UI_THROTTLE_MS = 10;

    // OPTIMIZACIÓN: Control de logs para evitar sobrecarga
    private logCounter = 0;
    private readonly LOG_EVERY_N_MESSAGES = 100;

    constructor(
        private platform: Platform, 
        private ngZone: NgZone, 
        private alertController: AlertController
    ) {
        this.setupDistanceTracking(); 
        this.loadSettings();
        this.startConnectionMonitoring();
        this.addLog('info', 'Servicio Bluetooth iniciado');
    }

    // ===================================
    // Lógica de Desacople y Conteo
    // ===================================

    private parseDistance(data: string): number | null {
        if (!data.startsWith('LOG:')) return null;
        
        const parts = data.split(':');
        if (parts.length >= 3) {
            const distance = parseInt(parts[2], 10);
            return !isNaN(distance) ? distance : null;
        }
        return null;
    }

    private setupDistanceTracking() {
        // Pipeline SOLO para la UI (con throttle)
        this.distanceCm$ = this.rawRxDataSubject.asObservable().pipe(
            filter(data => data.startsWith('LOG:')),
            map(data => this.parseDistance(data)),
            tap(distance => {
                if (distance !== null && distance < 100) {
                    this.updateTimeBelowThreshold();
                }
            }),
            throttleTime(this.UI_THROTTLE_MS), 
            shareReplay(1)
        );
    }

    // OPTIMIZACIÓN: Variables para tracking preciso del tiempo
    private lastTimestampBelowThreshold: number | null = null;
    private isCurrentlyBelowThreshold = false;

    private updateTimeBelowThreshold() {
        const now = Date.now();
        
        if (!this.isCurrentlyBelowThreshold) {
            this.lastTimestampBelowThreshold = now;
            this.isCurrentlyBelowThreshold = true;
        } else if (this.lastTimestampBelowThreshold !== null) {
            const elapsedMs = now - this.lastTimestampBelowThreshold;
            this.updateStatistics('timeBelowThreshold', elapsedMs / 1000);
            this.lastTimestampBelowThreshold = now;
        }
    }

    private resetTimeBelowThreshold() {
        this.lastTimestampBelowThreshold = null;
        this.isCurrentlyBelowThreshold = false;
    }
    
    // ===================================
    // Persistencia y Estado
    // ===================================

    private loadSettings() {
        try {
            const savedAutoReconnect = localStorage.getItem('autoReconnect');
            if (savedAutoReconnect !== null) this.autoReconnect = savedAutoReconnect === 'true';
            
            const savedDevice = localStorage.getItem('lastDevice');
            if (savedDevice) this.lastDeviceAddress = savedDevice;
            
            const savedStats = localStorage.getItem('bluetoothStats');
            if (savedStats) {
                const parsed = JSON.parse(savedStats);
                this.statisticsSubject.next({ 
                    ...this.statisticsSubject.value, 
                    ...parsed, 
                    connectionTime: null, 
                    uptime: 0,
                    timeBelowThreshold: parsed.timeBelowThreshold || 0 
                });
            }
        } catch (e) {
            console.error('Error cargando configuración', e);
        }
    }

    private saveSettings() {
        try {
            localStorage.setItem('autoReconnect', this.autoReconnect.toString());
            if (this.lastDeviceAddress) localStorage.setItem('lastDevice', this.lastDeviceAddress);
            
            const stats = this.statisticsSubject.value;
            const statsToSave = {
                messagesSent: stats.messagesSent, messagesReceived: stats.messagesReceived,
                bytesSent: stats.bytesSent, bytesReceived: stats.bytesReceived, errors: stats.errors,
                connectionAttempts: stats.connectionAttempts, successfulConnections: stats.successfulConnections,
                pairingAttempts: stats.pairingAttempts, successfulPairings: stats.successfulPairings,
                timeBelowThreshold: stats.timeBelowThreshold
            };
            localStorage.setItem('bluetoothStats', JSON.stringify(statsToSave));
        } catch (e) {
            console.error('Error guardando configuración', e);
        }
    }

    onAutoReconnectChange(enabled: boolean) {
        this.autoReconnect = enabled;
        this.saveSettings();
        this.addLog('info', `Auto-reconexión ${this.autoReconnect ? '✓ activada' : '✗ desactivada'}`);
    }

    // ===================================
    // Permisos
    // ===================================

    async requestRuntimePermissions(): Promise<boolean> {
        if (!this.platform.is('android')) return true;

        this.addLog('info', '🔐 Solicitando permisos en tiempo de ejecución...');

        try {
            if (cordova?.plugins?.permissions) {
                const permissions = cordova.plugins.permissions;
                const permissionsToRequest = [
                    permissions.BLUETOOTH_SCAN,
                    permissions.BLUETOOTH_CONNECT,
                    permissions.ACCESS_FINE_LOCATION 
                ];

                const granted = await new Promise<boolean>((resolve) => {
                    permissions.requestPermissions(
                        permissionsToRequest,
                        (status: any) => resolve(status.hasPermission),
                        () => resolve(false)
                    );
                });

                if (!granted) {
                    this.addLog('error', `❌ Permisos denegados`);
                    const alert = await this.alertController.create({
                        header: 'Permisos Requeridos',
                        message: 'La aplicación necesita permisos de Bluetooth y Ubicación para escanear y conectar dispositivos.',
                        buttons: ['OK']
                    });
                    await alert.present();
                    return false;
                }
                
                this.addLog('success', '✓ Permisos concedidos');
                return true;
            } else {
                this.addLog('warning', '⚠️ Plugin de permisos no disponible, intentando igualmente...');
                return true;
            }
        } catch (e: any) {
            this.addLog('error', `❌ Error solicitando permisos: ${e.message}`);
            return false;
        }
    }

    // ===================================
    // Conexión y Desconexión
    // ===================================
    
    private startConnectionMonitoring() {
        setInterval(() => {
            this.checkConnection();
        }, 5000);
    }

    async checkConnection() {
        if (typeof bluetoothSerial === 'undefined') return;

        try {
            const isConnected = await new Promise<boolean>((resolve) => {
                bluetoothSerial.isConnected(() => resolve(true), () => resolve(false));
            });

            this.ngZone.run(() => {
                const wasConnected = this.isConnectedSubject.value;
                this.isConnectedSubject.next(isConnected);

                if (isConnected && !wasConnected) {
                    this.addLog('connect', '✓ Conexión restaurada');
                    this.startUptimeCounter();
                } else if (!isConnected && wasConnected) {
                    this.addLog('disconnect', '⚠️ Conexión perdida');
                    this.handleDisconnection();
                }
            });
        } catch (error) {
            this.addLog('error', '❌ Error verificando conexión');
        }
    }

    async connectToDevice(device: BluetoothDevice, isReconnect: boolean = false): Promise<void> {
        if (typeof bluetoothSerial === 'undefined') return Promise.reject('Plugin no disponible');

        if (!isReconnect) {
            this.addLog('connect', `🔗 Conectando a ${device.name}...`);
        }
        
        this.updateStatistics('connectionAttempts');

        return new Promise((resolve, reject) => {
            bluetoothSerial.connect(
                device.address,
                () => {
                    this.ngZone.run(() => {
                        this.isConnectedSubject.next(true);
                        this.connectedDeviceSubject.next(device);
                        this.lastDeviceAddress = device.address;
                        this.updateStatistics('successfulConnections');
                        this.updateStatistics('connectionTime', new Date());
                        this.startUptimeCounter();
                        this.subscribeToData();
                        this.saveSettings();
                        this.resetTimeBelowThreshold();

                        if (!isReconnect) {
                            this.addLog('success', `✓ Conectado a ${device.name}`);
                        }
                        resolve();
                    });
                },
                (error: any) => {
                    this.ngZone.run(() => {
                        this.updateStatistics('errors');
                        if (!isReconnect) {
                            this.addLog('error', `❌ Error de conexión: ${error}`);
                        }
                        reject(error);
                    });
                }
            );
        });
    }

    async disconnect(): Promise<void> {
        if (typeof bluetoothSerial === 'undefined' || !this.isConnectedSubject.value) return;

        this.addLog('disconnect', '🔌 Desconectando...');
        
        const wasAutoReconnect = this.autoReconnect;
        this.autoReconnect = false; 

        return new Promise((resolve, reject) => {
            bluetoothSerial.disconnect(
                () => {
                    this.ngZone.run(() => {
                        this.isConnectedSubject.next(false);
                        this.connectedDeviceSubject.next(null);
                        this.stopUptimeCounter();
                        this.resetTimeBelowThreshold();
                        this.addLog('success', `✓ Desconexión manual exitosa`);
                        this.autoReconnect = wasAutoReconnect;
                        resolve();
                    });
                },
                (error: any) => {
                    this.ngZone.run(() => {
                        this.updateStatistics('errors');
                        this.addLog('error', `❌ Error al desconectar: ${error}`);
                        this.autoReconnect = wasAutoReconnect;
                        reject(error);
                    });
                }
            );
        });
    }

    // ===================================
    // Reconexión
    // ===================================

    private handleDisconnection() {
        this.stopUptimeCounter();
        this.resetTimeBelowThreshold();
        this.isConnectedSubject.next(false);
        this.connectedDeviceSubject.next(null);

        if (this.autoReconnect && this.lastDeviceAddress && !this.isReconnecting) {
            this.startReconnectionProcess();
        }
    }

    startReconnectionProcess() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.addLog('error', `❌ Máximo intentos de reconexión alcanzado (${this.maxReconnectAttempts})`);
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;
        this.addLog('info', `🔄 Intento ${this.reconnectAttempts}/${this.maxReconnectAttempts} en ${this.reconnectDelay / 1000}s...`);

        this.reconnectTimer = setTimeout(async () => {
            const tempDevice = { name: 'Último dispositivo', address: this.lastDeviceAddress! };
            try {
                await this.connectToDevice(tempDevice, true);
                this.ngZone.run(() => {
                    if (this.isConnectedSubject.value) {
                        this.reconnectAttempts = 0;
                        this.isReconnecting = false;
                        this.addLog('success', '✓ Reconexión exitosa');
                    } else {
                        this.startReconnectionProcess();
                    }
                });
            } catch (error) {
                this.ngZone.run(() => this.startReconnectionProcess());
            }
        }, this.reconnectDelay);
    }

    cancelReconnection() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.addLog('info', '🚫 Reconexión cancelada');
    }

    // ===================================
    // Datos y Comandos
    // ===================================

    private subscribeToData() {
        if (typeof bluetoothSerial === 'undefined') return;

        try {
            bluetoothSerial.unsubscribe();
            
            bluetoothSerial.subscribe(
                '\n',
                (data: string) => {
                    // OPTIMIZACIÓN CRÍTICA: Procesar FUERA de ngZone
                    const trimmedData = data.trim();
                    const bytes = new TextEncoder().encode(data).length;
                    
                    // 1. Emitir INMEDIATAMENTE al stream crudo (para tracking de tiempo)
                    this.rawRxDataSubject.next(trimmedData);
                    
                    // 2. ✅ COMPATIBILIDAD: También emitir al BehaviorSubject
                    this.rxDataSubject.next(trimmedData);
                    
                    // 3. Actualizar estadísticas en NgZone (optimizado)
                    this.ngZone.run(() => {
                        this.updateStatistics('messagesReceived');
                        this.updateStatistics('bytesReceived', bytes);
                        
                        // OPTIMIZACIÓN: Logging reducido
                        this.logCounter++;
                        if (this.logCounter >= this.LOG_EVERY_N_MESSAGES) {
                            this.addLog('rx', `${this.LOG_EVERY_N_MESSAGES} mensajes procesados`, bytes * this.LOG_EVERY_N_MESSAGES);
                            this.logCounter = 0;
                        }
                    });
                },
                (error: any) => {
                    this.ngZone.run(() => {
                        this.addLog('error', `❌ Error suscripción: ${error}`);
                        this.updateStatistics('errors');
                    });
                }
            );
            
            this.addLog('success', '✓ Suscrito al stream de alta velocidad');
        } catch (e) {
            this.addLog('warning', '⚠️ No se pudo suscribir');
        }
    }

    async sendCommand(command: string): Promise<void> {
        if (!this.isConnectedSubject.value || typeof bluetoothSerial === 'undefined') {
            this.addLog('warning', '⚠️ Comando NO enviado: Desconectado');
            return Promise.reject('No hay conexión activa');
        }

        const fullCommand = command.endsWith('\n') ? command : `${command}\n`;
        const bytes = new TextEncoder().encode(fullCommand).length;
        
        this.addLog('tx', command.trim(), bytes);

        return new Promise((resolve, reject) => {
            bluetoothSerial.write(
                fullCommand,
                () => {
                    this.ngZone.run(() => {
                        this.updateStatistics('messagesSent');
                        this.updateStatistics('bytesSent', bytes);
                        resolve();
                    });
                },
                (error: any) => {
                    this.ngZone.run(() => {
                        this.addLog('error', `❌ Error enviando: ${error}`);
                        this.updateStatistics('errors');
                        reject(error);
                    });
                }
            );
        });
    }

    // ===================================
    // Logs y Estadísticas
    // ===================================

    private updateStatistics(key: keyof Statistics, value: number | Date | null = 1) {
        const currentStats = this.statisticsSubject.value;
        const newStats = { ...currentStats };

        if (typeof value === 'number' && key in newStats && typeof newStats[key] === 'number') {
            (newStats[key] as number) = (newStats[key] as number) + value;
        } else if (key === 'connectionTime' && value instanceof Date) {
            newStats[key] = value;
        } else if (key === 'lastError' && typeof value === 'string') {
            newStats[key] = value;
        }
        this.statisticsSubject.next(newStats);
    }

    resetStatistics() {
        this.statisticsSubject.next({
            messagesSent: 0, messagesReceived: 0, bytesSent: 0, bytesReceived: 0,
            errors: 0, connectionAttempts: 0, successfulConnections: 0, pairingAttempts: 0,
            successfulPairings: 0, connectionTime: this.statisticsSubject.value.connectionTime,
            uptime: this.statisticsSubject.value.uptime, lastError: null,
            timeBelowThreshold: 0
        });
        this.resetTimeBelowThreshold();
        this.saveSettings();
        this.addLog('info', '📊 Estadísticas reseteadas');
    }

    private startUptimeCounter() {
        this.stopUptimeCounter();
        let stats = this.statisticsSubject.value;
        stats.uptime = 0;
        this.statisticsSubject.next(stats);
        
        this.uptimeInterval = setInterval(() => {
            this.ngZone.run(() => {
                let currentStats = this.statisticsSubject.value;
                currentStats.uptime++;
                this.statisticsSubject.next({ ...currentStats });
            });
        }, 1000);
    }

    private stopUptimeCounter() {
        if (this.uptimeInterval) {
            clearInterval(this.uptimeInterval);
            this.uptimeInterval = null;
        }
    }

    addLog(type: LogEntry['type'], message: string, bytes?: number) {
        const log: LogEntry = {
            timestamp: new Date(),
            type,
            message,
            bytes
        };

        this.ngZone.run(() => {
            const logs = this.logsSubject.value;
            logs.unshift(log);

            if (logs.length > this.maxLogs) {
                this.logsSubject.next(logs.slice(0, this.maxLogs));
            } else {
                this.logsSubject.next([...logs]);
            }
        });
        console.log(`[${type.toUpperCase()}] ${message}`);
    }
}