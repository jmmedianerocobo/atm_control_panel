import { Platform } from '@ionic/angular/standalone';

import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonBackButton,
  IonList,
  IonItem,
  IonLabel,
  IonBadge,
  IonButton,
  IonIcon,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardContent,
  IonNote,
  IonSpinner,
  IonToggle,
  IonChip,
  IonGrid,
  IonRow,
  IonCol,
  AlertController,
  IonCardSubtitle, 
  IonListHeader
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { 
  bluetoothOutline, 
  refreshOutline, 
  checkmarkCircle, 
  closeCircle,
  listOutline,
  statsChartOutline,
  timeOutline,
  sendOutline,
  downloadOutline,
  swapVerticalOutline,
  alertCircle,
  informationCircle,
  searchOutline,
  linkOutline,
  unlinkOutline
} from 'ionicons/icons';

import { BluetoothService, BluetoothDevice, DistanceTracking } from '../services/bluetooth.service_lst';

declare var bluetoothSerial: any;

interface LogEntry {
  timestamp: Date;
  type: 'rx' | 'tx' | 'pairing' | 'connect' | 'disconnect' | 'info' | 'success' | 'error' | 'warning';
  message: string;
  raw?: string;
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
}

@Component({
  selector: 'app-bt-settings',
  templateUrl: './bt-settings.page.html',
  styleUrls: ['./bt-settings.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButtons,
    IonBackButton,
    IonList,
    IonItem,
    IonLabel,
    IonBadge,
    IonButton,
    IonIcon,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonNote,
    IonSpinner,
    IonToggle,
    IonChip,
    IonGrid,
    IonRow,
    IonCol,
    IonCardSubtitle, 
    IonListHeader
  ]
})
export class BtSettingsPage implements OnInit, OnDestroy {
  isConnected = false;
  connectedDevice: BluetoothDevice | null = null;
  pairedDevices: BluetoothDevice[] = [];
  unpairedDevices: BluetoothDevice[] = [];
  isScanning = false;
  isDiscovering = false;
  isPairing = false;
  isBluetoothEnabled = false;
  logs: LogEntry[] = [];
  maxLogs = 300;
  simulationEnabled: boolean = false;
  
  autoReconnect = true;
  isReconnecting = false;
  reconnectAttempts = 0;
  maxReconnectAttempts = 5;
  reconnectDelay = 3000;
  private reconnectTimer: any;
  private connectionCheckInterval: any;
  
  statistics: Statistics = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    errors: 0,
    connectionAttempts: 0,
    successfulConnections: 0,
    pairingAttempts: 0,
    successfulPairings: 0,
    connectionTime: null,
    uptime: 0,
    lastError: null
  };
  private uptimeInterval: any;
  
  lastDeviceAddress: string | null = null;
  
  private subscriptions: Subscription[] = [];

  constructor(
    private platform: Platform, 
    private alertController: AlertController,
    public bluetoothService: BluetoothService
  ) {
    addIcons({ 
      bluetoothOutline, refreshOutline, checkmarkCircle, closeCircle,
      listOutline, statsChartOutline, timeOutline, sendOutline,
      downloadOutline, swapVerticalOutline, alertCircle, informationCircle,
      searchOutline, linkOutline, unlinkOutline
    });
  }

  ngOnInit() {
    this.addLog('info', '🚀 Sistema inicializado v5.0 - Modo ESCLAVO');
    this.loadSettings();
    this.checkBluetoothStatus();
    this.startConnectionMonitoring();
    
    this.subscriptions.push(
      this.bluetoothService.isConnected$.subscribe(status => this.isConnected = status),
      this.bluetoothService.connectedDevice$.subscribe(device => this.connectedDevice = device),
      this.bluetoothService.pairedDevices$.subscribe(devices => this.pairedDevices = devices),
      this.bluetoothService.unpairedDevices$.subscribe(devices => this.unpairedDevices = devices),
      this.bluetoothService.isScanning$.subscribe(isScanning => this.isDiscovering = isScanning),
      this.bluetoothService.isSimulationEnabled$.subscribe(enabled => {
        this.simulationEnabled = enabled; 
      }),
      this.bluetoothService.connectedDevice$.subscribe((device: BluetoothDevice | null) => {
        this.connectedDevice = device;
        
        if (device) {
          this.lastDeviceAddress = device.address;
        }
      }),
    );
  }

  ngOnDestroy() {
    this.stopConnectionMonitoring();
    this.stopUptimeCounter();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.saveSettings();
    
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  private loadSettings() {
    try {
      const savedAutoReconnect = localStorage.getItem('autoReconnect');
      if (savedAutoReconnect !== null) this.autoReconnect = savedAutoReconnect === 'true';
      
      const savedDevice = localStorage.getItem('lastDevice');
      if (savedDevice) this.lastDeviceAddress = savedDevice;
      
      const savedStats = localStorage.getItem('bluetoothStats');
      if (savedStats) {
        const parsed = JSON.parse(savedStats);
        this.statistics = { ...this.statistics, ...parsed };
        this.statistics.connectionTime = null;
        this.statistics.uptime = 0;
      }
    } catch (e) {
      console.error('Error cargando configuración', e);
    }
  }

  private saveSettings() {
    try {
      localStorage.setItem('autoReconnect', this.autoReconnect.toString());
      if (this.lastDeviceAddress) localStorage.setItem('lastDevice', this.lastDeviceAddress);
      
      const statsToSave = {
        messagesSent: this.statistics.messagesSent,
        messagesReceived: this.statistics.messagesReceived,
        bytesSent: this.statistics.bytesSent,
        bytesReceived: this.statistics.bytesReceived,
        errors: this.statistics.errors,
        connectionAttempts: this.statistics.connectionAttempts,
        successfulConnections: this.statistics.successfulConnections,
        pairingAttempts: this.statistics.pairingAttempts,
        successfulPairings: this.statistics.successfulPairings
      };
      localStorage.setItem('bluetoothStats', JSON.stringify(statsToSave));
    } catch (e) {
      console.error('Error guardando configuración', e);
    }
  }

  onAutoReconnectChange(event: any) {
    this.autoReconnect = event.detail.checked;
    this.saveSettings();
    this.addLog('info', `Auto-reconexión ${this.autoReconnect ? '✓ activada' : '✗ desactivada'}`);
  }

  private startConnectionMonitoring() {
    this.connectionCheckInterval = setInterval(() => {
      this.checkConnection();
    }, 5000);
  }

  private stopConnectionMonitoring() {
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
      this.connectionCheckInterval = null;
    }
  }

  async checkBluetoothStatus() {
    if (typeof bluetoothSerial === 'undefined') {
      this.addLog('error', '❌ Plugin Bluetooth no disponible');
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.isEnabled(
          () => {
            this.isBluetoothEnabled = true;
            this.addLog('success', '✓ Bluetooth habilitado');
            resolve();
          },
          () => {
            this.isBluetoothEnabled = false;
            this.addLog('warning', '⚠️ Bluetooth deshabilitado');
            reject();
          }
        );
      });

      await this.bluetoothService.loadPairedDevices();
      await this.checkConnection();

      if (this.autoReconnect && !this.isConnected && this.lastDeviceAddress) {
        const device = this.pairedDevices.find(d => d.address === this.lastDeviceAddress);
        if (device) await this.connectToDevice(device);
      }
    } catch (error) {
      this.addLog('error', '❌ Error verificando Bluetooth');
    }
  }

  async checkConnection() {
    if (typeof bluetoothSerial === 'undefined') return;

    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.isConnected(
          () => {
            if (!this.isConnected) {
              this.isConnected = true; 
              this.addLog('connect', '✓ Conexión restaurada');
              if (!this.uptimeInterval) this.startUptimeCounter();
            }
            resolve();
          },
          () => {
            if (this.isConnected) {
              this.addLog('disconnect', '⚠️ Conexión perdida');
              this.handleDisconnection();
            }
            this.isConnected = false;
            this.connectedDevice = null;
            resolve();
          }
        );
      });
    } catch (error) {
      this.addLog('error', '❌ Error verificando conexión');
    }
  }

  private handleDisconnection() {
    this.isConnected = false;
    this.stopUptimeCounter();
    
    if (this.autoReconnect && this.lastDeviceAddress && !this.isReconnecting) {
      this.startReconnectionProcess();
    }
  }

  private async startReconnectionProcess() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.addLog('error', `❌ Máximo intentos alcanzado (${this.maxReconnectAttempts})`);
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    this.addLog('info', `🔄 Intento ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);

    await new Promise(resolve => {
      this.reconnectTimer = setTimeout(resolve, this.reconnectDelay);
    });

    const device = this.pairedDevices.find(d => d.address === this.lastDeviceAddress);
    if (device) {
      try {
        await this.connectToDevice(device, true);
        if (this.isConnected) {
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
          this.addLog('success', '✓ Reconexión exitosa');
        } else {
          this.startReconnectionProcess();
        }
      } catch (error) {
        this.startReconnectionProcess();
      }
    } else {
      this.isReconnecting = false;
      this.addLog('error', '❌ Dispositivo no encontrado');
    }
  }

  cancelReconnection() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.addLog('info', '🚫 Reconexión cancelada');
  }

  async enableBluetooth() {
    if (typeof bluetoothSerial === 'undefined') {
      this.addLog('error', '❌ Plugin no disponible');
      return;
    }

    this.addLog('info', '📡 Habilitando Bluetooth...');
    
    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.enable(
          () => {
            this.isBluetoothEnabled = true;
            this.addLog('success', '✓ Bluetooth habilitado');
            resolve();
          },
          (error: any) => {
            this.addLog('error', `❌ Error: ${error}`);
            this.statistics.errors++;
            reject(error);
          }
        );
      });

      await this.bluetoothService.loadPairedDevices();
    } catch (error) {
      this.addLog('error', '❌ No se pudo habilitar');
    }
  }

  async loadPairedDevices() {
    this.isScanning = true;
    try {
      await this.bluetoothService.loadPairedDevices();
    } catch (e) {
      this.addLog('error', `❌ Falló la carga de emparejados: ${e}`);
    } finally {
      this.isScanning = false;
    }
  }

  // ========================================
  // ✅ ACTUALIZADO: Conexión sin START automático
  // ========================================
  async connectToDevice(device: BluetoothDevice, isReconnect: boolean = false) {
    if (typeof bluetoothSerial === 'undefined') return;

    if (!isReconnect) {
      this.addLog('connect', `🔗 Conectando a ${device.name}...`);
    }
    
    this.statistics.connectionAttempts++;

    try {
      await this.bluetoothService.connect(device.address);

      this.statistics.successfulConnections++;
      this.statistics.connectionTime = new Date();
      this.startUptimeCounter();
      this.lastDeviceAddress = device.address;
      
      if (!isReconnect) {
        this.addLog('success', `✓ Conectado a ${device.name}`);
      }
      
      // ✅ ACTUALIZADO: Mensajes del nuevo sistema
      this.addLog('info', '✓ Conexión establecida. Arduino en modo ESCLAVO.');
      this.addLog('info', 'ℹ️ Control de relés desde Angular via toggles.');
      
      // Solicitar estado actual del Arduino
      setTimeout(() => {
        this.requestArduinoStatus();
        
        // Verificar llegada de datos
        const stats = this.bluetoothService.getStats();
        if (stats.dataReceivedCount === 0) {
          this.addLog('warning', '⚠️ No se reciben datos del Arduino.');
          this.addLog('info', 'ℹ️ El Arduino envía datos automáticamente cada 100ms.');
        } else {
          this.addLog('success', `✅ Recibidos ${stats.dataReceivedCount} mensajes`);
        }
      }, 1500);
      
      this.saveSettings();
    } catch (error) {
      this.addLog('error', `❌ Error conectando: ${error}`);
      this.statistics.errors++;
      this.isConnected = false;
      this.connectedDevice = null;
      throw error;
    }
  }

  async disconnect() {
    if (typeof bluetoothSerial === 'undefined') return;

    const wasAutoReconnect = this.autoReconnect;
    this.autoReconnect = false;
    this.addLog('disconnect', '🔌 Solicitando desconexión...');

    try {
      await this.bluetoothService.disconnect();
      this.stopUptimeCounter();
    } catch (error) {
      this.addLog('error', `❌ Error: ${error}`);
      this.statistics.errors++;
    }

    this.autoReconnect = wasAutoReconnect;
  }

  async sendCommand(command: string) {
    if (!this.isConnected) {
      this.addLog('warning', '⚠️ No hay conexión activa');
      return;
    }

    const fullCommand = command.endsWith('\n') ? command : `${command}\n`;
    const bytes = new TextEncoder().encode(fullCommand).length;
    
    this.addLog('tx', command, fullCommand, bytes);

    try {
      await this.bluetoothService.sendCommand(command);
      this.statistics.messagesSent++;
      this.statistics.bytesSent += bytes;
    } catch (error) {
      this.addLog('error', `❌ Error enviando: ${error}`);
      this.statistics.errors++;
    }
  }

  async sendJsonCommand(cmd: string) {
  const id = Date.now() % 100000; // ID único
  const json = JSON.stringify({ cmd, id });
  return this.sendCommand(json);
}

  
  // ========================================
  // ✅ MÉTODOS DE PRUEBA ACTUALIZADOS
  // ========================================
  
  async sendTestCommand() {
    await this.sendJsonCommand('V50');
  }

  async requestSTATS() {
    await this.sendJsonCommand('STATS');
  }

  // ✅ NUEVO: Solicitar estado actual del Arduino
  async requestArduinoStatus() {
    await this.sendJsonCommand('STATUS');
    this.addLog('info', '📊 Solicitando estado del Arduino');
  }

  async requestRuntimePermissions(): Promise<boolean> {
    if (!this.platform.is('android')) return true;

    this.addLog('info', '🔐 Solicitando permisos en tiempo de ejecución...');

    try {
      if ((window as any).cordova?.plugins?.permissions) {
        const permissions = (window as any).cordova.plugins.permissions;
        
        const permissionsToRequest = [
          'android.permission.BLUETOOTH_SCAN',
          'android.permission.BLUETOOTH_CONNECT',
          'android.permission.ACCESS_FINE_LOCATION'
        ];
        
        let allGranted = true;

        for (const permission of permissionsToRequest) {
          const hasPermission = await new Promise<boolean>((resolve) => {
            permissions.checkPermission(permission, (status: any) => {
              resolve(status.hasPermission);
            });
          });

          if (!hasPermission) {
            this.addLog('info', `Solicitando ${permission}...`);
            
            const granted = await new Promise<boolean>((resolve) => {
              permissions.requestPermission(
                permission,
                (status: any) => resolve(status.hasPermission),
                () => resolve(false)
              );
            });

            if (!granted) {
              this.addLog('error', `❌ Permiso ${permission} denegado`);
              allGranted = false;
            } else {
              this.addLog('success', `✓ Permiso ${permission} concedido`);
            }
          }
        }
        
        if (!allGranted) {
          const alert = await this.alertController.create({
            header: 'Permisos Requeridos',
            message: 'La aplicación necesita permisos de Bluetooth y Ubicación para escanear dispositivos.',
            buttons: ['OK']
          });
          await alert.present();
        }

        if (allGranted) this.addLog('success', '✓ Todos los permisos concedidos');
        return allGranted;
      } else {
        this.addLog('warning', '⚠️ Plugin de permisos no disponible, intentando igualmente...');
        return true;
      }
    } catch (e: any) {
      this.addLog('error', `❌ Error solicitando permisos: ${e.message}`);
      return false;
    }
  }

  async scanForUnpaired() {
    const hasPermissions = await this.requestRuntimePermissions();
    if (!hasPermissions) {
      this.addLog('warning', '⚠️ Escaneo cancelado: sin permisos');
      return;
    }

    await this.bluetoothService.scanForUnpaired();
  }

  async pairAndConnect(device: BluetoothDevice) {
    if (typeof bluetoothSerial === 'undefined') return;
    
    this.isPairing = true;
    this.statistics.pairingAttempts++;
    const deviceName = device.name || device.address;
    
    this.addLog('pairing', `🔗 Emparejando con ${deviceName}...`);

    try {
      await this.connectToDevice(device);
      
      if (this.isConnected) {
        this.statistics.successfulPairings++;
        
        if (!this.pairedDevices.find(d => d.address === device.address)) {
          this.pairedDevices.unshift(device);
        }
        this.unpairedDevices = this.unpairedDevices.filter(d => d.address !== device.address);
        
        this.addLog('success', `✓ Emparejado: ${deviceName}`);
        
        const alert = await this.alertController.create({
          header: '¡Éxito!',
          message: `Emparejado con "${deviceName}"`,
          buttons: ['OK']
        });
        await alert.present();
      }
    } catch (error) {
      const alert = await this.alertController.create({
        header: 'Error',
        message: `No se pudo emparejar con "${deviceName}"`,
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      this.isPairing = false;
    }
  }

  private startUptimeCounter() {
    this.stopUptimeCounter();
    this.statistics.uptime = 0;
    
    this.uptimeInterval = setInterval(() => {
      this.statistics.uptime++;
    }, 1000);
  }

  private stopUptimeCounter() {
    if (this.uptimeInterval) {
      clearInterval(this.uptimeInterval);
      this.uptimeInterval = null;
    }
  }

  formatUptime(): string {
    const hours = Math.floor(this.statistics.uptime / 3600);
    const minutes = Math.floor((this.statistics.uptime % 3600) / 60);
    const seconds = this.statistics.uptime % 60;
    
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  getSuccessRate(): number {
    if (this.statistics.connectionAttempts === 0) return 0;
    return Math.round((this.statistics.successfulConnections / this.statistics.connectionAttempts) * 100);
  }

  getPairingSuccessRate(): number {
    if (this.statistics.pairingAttempts === 0) return 0;
    return Math.round((this.statistics.successfulPairings / this.statistics.pairingAttempts) * 100);
  }

  resetStatistics() {
    this.statistics = {
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      errors: 0,
      connectionAttempts: 0,
      successfulConnections: 0,
      pairingAttempts: 0,
      successfulPairings: 0,
      connectionTime: this.statistics.connectionTime,
      uptime: this.statistics.uptime,
      lastError: null
    };
    this.saveSettings();
    this.addLog('info', '📊 Estadísticas reseteadas');
  }

  clearLogs() {
    const count = this.logs.length;
    this.logs = [];
    this.addLog('info', `🗑️ ${count} logs eliminados`);
  }

  exportLogs() {
    const logsText = this.logs.map(log => {
      const time = this.formatTime(log.timestamp);
      const type = log.type.toUpperCase().padEnd(10);
      const bytes = log.bytes ? ` [${log.bytes}B]` : '';
      return `[${time}] [${type}]${bytes} ${log.message}`;
    }).reverse().join('\n');
    
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bt-logs-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    
    this.addLog('success', '✓ Logs exportados');
  }

  private addLog(type: LogEntry['type'], message: string, raw?: string, bytes?: number) {
    const log: LogEntry = {
      timestamp: new Date(),
      type,
      message,
      raw,
      bytes
    };

    this.logs.unshift(log);

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }

    const icon = this.getLogEmoji(type);
    console.log(`${icon} [${type.toUpperCase()}] ${message}`);
  }

  private getLogEmoji(type: string): string {
    const emojis: { [key: string]: string } = {
      'rx': '📩',
      'tx': '📤',
      'pairing': '🔗',
      'connect': '🔌',
      'disconnect': '🔌',
      'success': '✅',
      'error': '❌',
      'warning': '⚠️',
      'info': 'ℹ️'
    };
    return emojis[type] || 'ℹ️';
  }

  getLogIcon(type: string): string {
    const icons: { [key: string]: string } = {
      'rx': 'download-outline',
      'tx': 'send-outline',
      'pairing': 'link-outline',
      'connect': 'link-outline',
      'disconnect': 'unlink-outline',
      'success': 'checkmark-circle',
      'error': 'close-circle',
      'warning': 'alert-circle',
      'info': 'information-circle'
    };
    return icons[type] || 'information-circle';
  }

  getLogColor(type: string): string {
    const colors: { [key: string]: string } = {
      'rx': 'success',
      'tx': 'primary',
      'pairing': 'tertiary',
      'connect': 'success',
      'disconnect': 'warning',
      'success': 'success',
      'error': 'danger',
      'warning': 'warning',
      'info': 'medium'
    };
    return colors[type] || 'medium';
  }

  formatTime(date: Date): string {
    const d = (date instanceof Date) ? date : new Date(date);
    const time = d.toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const ms = d.getMilliseconds().toString().padStart(3, '0');
    return `${time}.${ms}`;
  }

  onSimulationChange(event: any) {
    const enabled = event.detail.checked;
    this.simulationEnabled = enabled;
    this.bluetoothService.toggleSimulationMode(enabled);
    this.addLog('info', `Modo simulación cambiado a: ${enabled}`);
  }

  async connectLastDevice() {
    if (this.isConnected) return;

    if (!this.lastDeviceAddress) {
      this.addLog('warning', '⚠️ No hay dirección de último dispositivo guardada.');
      return;
    }
    
    this.addLog('info', `Conectando a último dispositivo: ${this.lastDeviceAddress}`);

    const device: BluetoothDevice = { 
      name: 'Último Conocido', 
      address: this.lastDeviceAddress, 
      id: this.lastDeviceAddress 
    };
    
    await this.connectToDevice(device);
  }
}