import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { 
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonBackButton, IonList, 
    IonItem, IonLabel, IonBadge, IonButton, IonIcon, IonCard, IonCardHeader, 
    IonCardTitle, IonCardContent, IonNote, IonSpinner, IonToggle, IonChip, 
    IonGrid, IonRow, IonCol, AlertController, Platform
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { 
    bluetoothOutline, refreshOutline, checkmarkCircle, closeCircle, listOutline,
    statsChartOutline, timeOutline, sendOutline, downloadOutline, swapVerticalOutline,
    alertCircle, informationCircle, searchOutline, linkOutline, unlinkOutline
} from 'ionicons/icons';
import { BluetoothService } from '../bluetooth.service';
import { Observable, Subscription } from 'rxjs';

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
    messagesSent: number; messagesReceived: number; bytesSent: number; bytesReceived: number;
    errors: number; connectionAttempts: number; successfulConnections: number;
    pairingAttempts: number; successfulPairings: number; connectionTime: Date | null;
    uptime: number; lastError: string | null;
}

declare var bluetoothSerial: any; // Mantenemos la declaración para llamadas directas del plugin

@Component({
    selector: 'app-bt-settings',
    templateUrl: './bt-settings.page.html',
    styleUrls: ['./bt-settings.page.scss'],
    standalone: true,
    imports: [
        CommonModule, FormsModule, IonHeader, IonToolbar, IonTitle, IonContent, 
        IonButtons, IonBackButton, IonList, IonItem, IonLabel, IonBadge, IonButton, 
        IonIcon, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonNote, 
        IonSpinner, IonToggle, IonChip, IonGrid, IonRow, IonCol
    ]
})
export class BtSettingsPage implements OnInit, OnDestroy {
    
    // Observables del servicio
    isConnected$: Observable<boolean>;
    connectedDevice$: Observable<BluetoothDevice | null>;
    logs$: Observable<LogEntry[]>;
    statistics$: Observable<Statistics>;
    
    // Propiedades locales
    autoReconnect = false;
    isScanning = false;
    isDiscovering = false;
    isPairing = false;
    pairedDevices: BluetoothDevice[] = [];
    unpairedDevices: BluetoothDevice[] = [];
    isBluetoothEnabled = false;

    private subscriptions = new Subscription();

    constructor(
        private platform: Platform,
        private alertController: AlertController,
        public btService: BluetoothService // Hacemos público el servicio para usar sus métodos
    ) {
        addIcons({ 
            bluetoothOutline, refreshOutline, checkmarkCircle, closeCircle,
            listOutline, statsChartOutline, timeOutline, sendOutline,
            downloadOutline, swapVerticalOutline, alertCircle, informationCircle,
            searchOutline, linkOutline, unlinkOutline
        });
        
        // Asignar Observables
        this.isConnected$ = this.btService.isConnected$;
        this.connectedDevice$ = this.btService.connectedDevice$;
        this.logs$ = this.btService.logs$;
        this.statistics$ = this.btService.statistics$;
    }

    ngOnInit() {
        this.subscriptions.add(this.btService.statistics$.subscribe(stats => {
            // Podemos calcular tasas aquí si es necesario, o en el HTML.
        }));
        this.autoReconnect = this.btService.autoReconnect;
        this.checkBluetoothStatus();
        this.loadPairedDevices();
    }

    ngOnDestroy() {
        this.subscriptions.unsubscribe();
    }

    // ===================================
    // Control de Bluetooth
    // ===================================

    async checkBluetoothStatus() {
        if (typeof bluetoothSerial === 'undefined') return;

        try {
            await new Promise<void>((resolve, reject) => {
                bluetoothSerial.isEnabled(
                    () => { this.isBluetoothEnabled = true; resolve(); },
                    () => { this.isBluetoothEnabled = false; reject(); }
                );
            });
            this.btService.addLog('success', '✓ Bluetooth habilitado');
        } catch (error) {
            this.btService.addLog('warning', '⚠️ Bluetooth deshabilitado');
        }
    }

    async enableBluetooth() {
        if (typeof bluetoothSerial === 'undefined') return;
        this.btService.addLog('info', '📡 Habilitando Bluetooth...');
        
        try {
            await new Promise<void>((resolve, reject) => {
                bluetoothSerial.enable(() => resolve(), (error: any) => reject(error));
            });
            this.isBluetoothEnabled = true;
            this.btService.addLog('success', '✓ Bluetooth habilitado');
            await this.loadPairedDevices();
        } catch (error) {
            this.btService.addLog('error', `❌ Error: ${error}`);
        }
    }
    
    // ===================================
    // Listado de Dispositivos
    // ===================================

    async loadPairedDevices() {
        if (typeof bluetoothSerial === 'undefined') return;

        this.isScanning = true;
        this.btService.addLog('info', '🔍 Buscando emparejados...');

        try {
            const devices = await new Promise<BluetoothDevice[]>((resolve, reject) => {
                bluetoothSerial.list(resolve, reject);
            });

            this.pairedDevices = devices;
            this.btService.addLog('success', `✓ ${devices.length} emparejado(s)`);
        } catch (error) {
            this.btService.addLog('error', `❌ Error listando: ${error}`);
        } finally {
            this.isScanning = false;
        }
    }

    async scanForUnpaired() {
        if (typeof bluetoothSerial === 'undefined') return;

        // 1. Solicitar permisos (usa la lógica centralizada del servicio)
        const hasPermissions = await this.btService.requestRuntimePermissions();
        if (!hasPermissions) {
            this.btService.addLog('warning', '⚠️ Escaneo cancelado: sin permisos');
            return;
        }

        this.isDiscovering = true;
        this.unpairedDevices = [];
        this.btService.addLog('info', '🔍 Escaneando dispositivos...');

        try {
            const devices = await new Promise<BluetoothDevice[]>((resolve, reject) => {
                const timeout = setTimeout(() => reject('Timeout: Escaneo tardó más de 30s'), 30000);
                
                // Usar discoverUnpaired o fallback a list()
                const success = (list: BluetoothDevice[]) => { clearTimeout(timeout); resolve(list); };
                const error = (err: any) => { clearTimeout(timeout); reject(err); };

                if (bluetoothSerial.discoverUnpaired) {
                    bluetoothSerial.discoverUnpaired(success, error);
                } else {
                    bluetoothSerial.list(success, error); // Fallback
                }
            });

            this.unpairedDevices = devices.filter(d => 
                !this.pairedDevices.some(p => p.address === d.address)
            );
            this.btService.addLog('success', `✓ ${this.unpairedDevices.length} dispositivos nuevos`);
        } catch (error) {
            this.btService.addLog('error', `❌ Error escaneando: ${error}`);
        } finally {
            this.isDiscovering = false;
        }
    }

    async connectOrPair(device: BluetoothDevice) {
        if (this.btService.isConnectedSubject.value) {
            await this.btService.disconnect();
        }
        
        this.isPairing = true; // Usamos pairing para conexión y emparejamiento
        this.btService.addLog('pairing', `🔗 Intentando conectar/emparejar con ${device.name}...`);
        
        try {
            await this.btService.connectToDevice(device);
            this.btService.addLog('success', `✓ Conexión exitosa: ${device.name}`);
            
            // Mover de no emparejados a emparejados si la conexión fue exitosa
            if (!this.pairedDevices.find(d => d.address === device.address)) {
                this.pairedDevices.unshift(device);
            }
            this.unpairedDevices = this.unpairedDevices.filter(d => d.address !== device.address);

        } catch (error) {
            this.btService.addLog('error', `❌ Fallo de conexión/emparejamiento: ${device.name}`);
        } finally {
            this.isPairing = false;
        }
    }

    // ===================================
    // Utilidades
    // ===================================

    onAutoReconnectChange(event: any) {
        this.autoReconnect = event.detail.checked;
        this.btService.onAutoReconnectChange(this.autoReconnect);
    }
    
    // Métodos delegados al servicio
    disconnect() {
        this.btService.disconnect();
    }
    cancelReconnection() {
        this.btService.cancelReconnection();
    }
    resetStatistics() {
        this.btService.resetStatistics();
    }
    clearLogs() {
        this.btService.logsSubject.next([]);
        this.btService.addLog('info', `🗑️ Logs eliminados`);
    }
    
    // Métodos para presentación (Helper functions)

    formatUptime(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
        if (minutes > 0) return `${minutes}m ${secs}s`;
        return `${secs}s`;
    }
    
    getSuccessRate(successful: number, attempts: number): number {
        if (attempts === 0) return 0;
        return Math.round((successful / attempts) * 100);
    }

    getLogIcon(type: string): string {
        // ... Lógica de iconos (igual que antes)
        const icons: { [key: string]: string } = {
            'rx': 'download-outline', 'tx': 'send-outline', 'pairing': 'link-outline',
            'connect': 'link-outline', 'disconnect': 'unlink-outline', 'success': 'checkmark-circle',
            'error': 'close-circle', 'warning': 'alert-circle', 'info': 'information-circle'
        };
        return icons[type] || 'information-circle';
    }

    getLogColor(type: string): string {
        // ... Lógica de colores (igual que antes)
        const colors: { [key: string]: string } = {
            'rx': 'success', 'tx': 'primary', 'pairing': 'tertiary', 'connect': 'success',
            'disconnect': 'warning', 'success': 'success', 'error': 'danger', 
            'warning': 'warning', 'info': 'medium'
        };
        return colors[type] || 'medium';
    }

    formatTime(date: Date): string {
        const d = (date instanceof Date) ? date : new Date(date);
        const time = d.toLocaleTimeString('es-ES', {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const ms = d.getMilliseconds().toString().padStart(3, '0');
        return `${time}.${ms}`;
    }
}