import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
  IonCol
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
  informationCircle
} from 'ionicons/icons';

declare var bluetoothSerial: any;

interface BluetoothDevice {
  name: string;
  address: string;
  id?: string;
  class?: number;
}

interface LogEntry {
  timestamp: Date;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
}

interface Statistics {
  messagesSent: number;
  messagesReceived: number;
  errors: number;
  connectionAttempts: number;
  successfulConnections: number;
  connectionTime: Date | null;
  uptime: number;
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
    IonCol
  ]
})
export class BtSettingsPage implements OnInit, OnDestroy {
  isConnected = false;
  connectedDevice: BluetoothDevice | null = null;
  pairedDevices: BluetoothDevice[] = [];
  isScanning = false;
  isBluetoothEnabled = false;
  logs: LogEntry[] = [];
  maxLogs = 100;
  
  // Auto-reconexión
  autoReconnect = true;
  isReconnecting = false;
  reconnectAttempts = 0;
  maxReconnectAttempts = 5;
  reconnectDelay = 3000;
  private reconnectTimer: any;
  private connectionCheckInterval: any;
  
  // Estadísticas
  statistics: Statistics = {
    messagesSent: 0,
    messagesReceived: 0,
    errors: 0,
    connectionAttempts: 0,
    successfulConnections: 0,
    connectionTime: null,
    uptime: 0
  };
  private uptimeInterval: any;
  
  lastDeviceAddress: string | null = null;

  constructor() {
    addIcons({ 
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
      informationCircle
    });
  }

  ngOnInit() {
    this.addLog('info', 'Página de configuración cargada');
    this.checkBluetoothStatus();
    this.startConnectionMonitoring();
    this.loadSettings();
  }

  ngOnDestroy() {
    this.stopConnectionMonitoring();
    this.stopUptimeCounter();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.saveSettings();
  }

  // ========== GESTIÓN DE CONFIGURACIÓN ==========
  
  private loadSettings() {
    const savedAutoReconnect = localStorage.getItem('autoReconnect');
    if (savedAutoReconnect !== null) {
      this.autoReconnect = savedAutoReconnect === 'true';
    }
    
    const savedDevice = localStorage.getItem('lastDevice');
    if (savedDevice) {
      this.lastDeviceAddress = savedDevice;
    }
    
    const savedStats = localStorage.getItem('bluetoothStats');
    if (savedStats) {
      try {
        const parsed = JSON.parse(savedStats);
        this.statistics = { ...this.statistics, ...parsed };
        this.statistics.connectionTime = null;
        this.statistics.uptime = 0;
      } catch (e) {
        console.error('Error al cargar estadísticas', e);
      }
    }
  }

  private saveSettings() {
    localStorage.setItem('autoReconnect', this.autoReconnect.toString());
    if (this.lastDeviceAddress) {
      localStorage.setItem('lastDevice', this.lastDeviceAddress);
    }
    
    const statsToSave = {
      messagesSent: this.statistics.messagesSent,
      messagesReceived: this.statistics.messagesReceived,
      errors: this.statistics.errors,
      connectionAttempts: this.statistics.connectionAttempts,
      successfulConnections: this.statistics.successfulConnections
    };
    localStorage.setItem('bluetoothStats', JSON.stringify(statsToSave));
  }

  onAutoReconnectChange(event: any) {
    this.autoReconnect = event.detail.checked;
    this.saveSettings();
    this.addLog('info', `Auto-reconexión ${this.autoReconnect ? 'activada' : 'desactivada'}`);
  }

  // ========== MONITOREO DE CONEXIÓN ==========
  
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
      this.addLog('error', 'Plugin Bluetooth no disponible');
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.isEnabled(
          () => {
            this.isBluetoothEnabled = true;
            this.addLog('success', 'Bluetooth está habilitado');
            resolve();
          },
          () => {
            this.isBluetoothEnabled = false;
            this.addLog('warning', 'Bluetooth está deshabilitado');
            reject();
          }
        );
      });

      await this.checkConnection();
      await this.loadPairedDevices();
      
      if (this.autoReconnect && !this.isConnected && this.lastDeviceAddress) {
        this.addLog('info', 'Intentando reconectar al último dispositivo...');
        const device = this.pairedDevices.find(d => d.address === this.lastDeviceAddress);
        if (device) {
          await this.connectToDevice(device);
        }
      }
    } catch (error) {
      this.addLog('error', 'Error al verificar Bluetooth');
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
              this.addLog('success', 'Conexión restaurada');
            }
            this.isConnected = true;
            resolve();
          },
          () => {
            if (this.isConnected) {
              this.addLog('warning', 'Conexión perdida');
              this.handleDisconnection();
            }
            this.isConnected = false;
            this.connectedDevice = null;
            resolve();
          }
        );
      });
    } catch (error) {
      this.addLog('error', 'Error al verificar conexión');
    }
  }

  // ========== AUTO-RECONEXIÓN ==========
  
  private handleDisconnection() {
    this.isConnected = false;
    this.stopUptimeCounter();
    
    if (this.autoReconnect && this.lastDeviceAddress && !this.isReconnecting) {
      this.startReconnectionProcess();
    }
  }

  private async startReconnectionProcess() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.addLog('error', `Máximo de intentos alcanzado (${this.maxReconnectAttempts})`);
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    
    this.addLog('info', `Intento de reconexión ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);

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
      this.addLog('error', 'Dispositivo no encontrado para reconectar');
    }
  }

  cancelReconnection() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.addLog('info', 'Reconexión cancelada por el usuario');
  }

  // ========== GESTIÓN DE BLUETOOTH ==========

  async enableBluetooth() {
    if (typeof bluetoothSerial === 'undefined') {
      this.addLog('error', 'Plugin no disponible');
      return;
    }

    this.addLog('info', 'Solicitando habilitar Bluetooth...');
    
    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.enable(
          () => {
            this.isBluetoothEnabled = true;
            this.addLog('success', 'Bluetooth habilitado');
            resolve();
          },
          (error: any) => {
            this.addLog('error', `Error al habilitar: ${error}`);
            reject(error);
          }
        );
      });

      await this.loadPairedDevices();
    } catch (error) {
      this.addLog('error', 'No se pudo habilitar Bluetooth');
    }
  }

  async loadPairedDevices() {
    if (typeof bluetoothSerial === 'undefined') return;

    this.isScanning = true;
    this.addLog('info', 'Buscando dispositivos emparejados...');

    try {
      const devices = await new Promise<BluetoothDevice[]>((resolve, reject) => {
        bluetoothSerial.list(
          (deviceList: BluetoothDevice[]) => resolve(deviceList),
          (error: any) => reject(error)
        );
      });

      this.pairedDevices = devices;
      this.addLog('success', `${devices.length} dispositivo(s) encontrado(s)`);
      
      devices.forEach(device => {
        this.addLog('info', `- ${device.name} (${device.address})`);
      });
    } catch (error) {
      this.addLog('error', `Error al listar dispositivos: ${error}`);
      this.pairedDevices = [];
      this.statistics.errors++;
    } finally {
      this.isScanning = false;
    }
  }

  async connectToDevice(device: BluetoothDevice, isReconnect: boolean = false) {
    if (typeof bluetoothSerial === 'undefined') return;

    if (!isReconnect) {
      this.addLog('info', `Conectando a ${device.name}...`);
    }
    
    this.statistics.connectionAttempts++;

    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.connect(
          device.address,
          () => {
            this.isConnected = true;
            this.connectedDevice = device;
            this.lastDeviceAddress = device.address;
            this.statistics.successfulConnections++;
            this.statistics.connectionTime = new Date();
            this.startUptimeCounter();
            
            if (!isReconnect) {
              this.addLog('success', `✓ Conectado a ${device.name}`);
            }
            
            this.subscribeToData();
            this.saveSettings();
            resolve();
          },
          (error: any) => {
            if (!isReconnect) {
              this.addLog('error', `Error de conexión: ${error}`);
            }
            this.statistics.errors++;
            reject(error);
          }
        );
      });
    } catch (error) {
      this.isConnected = false;
      this.connectedDevice = null;
    }
  }

  async disconnect() {
    if (typeof bluetoothSerial === 'undefined') return;

    this.addLog('info', 'Desconectando...');

    const wasAutoReconnect = this.autoReconnect;
    this.autoReconnect = false;

    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.disconnect(
          () => {
            this.isConnected = false;
            this.connectedDevice = null;
            this.stopUptimeCounter();
            this.addLog('success', 'Desconectado correctamente');
            resolve();
          },
          (error: any) => {
            this.addLog('error', `Error al desconectar: ${error}`);
            this.statistics.errors++;
            reject(error);
          }
        );
      });
    } catch (error) {
      this.isConnected = false;
      this.connectedDevice = null;
      this.stopUptimeCounter();
    }

    this.autoReconnect = wasAutoReconnect;
  }

  subscribeToData() {
    if (typeof bluetoothSerial === 'undefined') return;

    bluetoothSerial.subscribe(
      '\n',
      (data: string) => {
        this.statistics.messagesReceived++;
        this.addLog('info', `📩 ${data.trim()}`);
      },
      (error: any) => {
        this.addLog('error', `Error de suscripción: ${error}`);
        this.statistics.errors++;
      }
    );
  }

  async sendTestCommand() {
    if (!this.isConnected || typeof bluetoothSerial === 'undefined') {
      this.addLog('warning', 'No hay conexión activa');
      return;
    }

    const testCommand = 'V50\n';
    this.addLog('info', `📤 ${testCommand.trim()}`);

    try {
      await new Promise<void>((resolve, reject) => {
        bluetoothSerial.write(
          testCommand,
          () => {
            this.statistics.messagesSent++;
            this.addLog('success', '✓ Comando enviado');
            resolve();
          },
          (error: any) => {
            this.addLog('error', `Error al enviar: ${error}`);
            this.statistics.errors++;
            reject(error);
          }
        );
      });
    } catch (error) {
      // Error ya registrado
    }
  }

  // ========== ESTADÍSTICAS ==========
  
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
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  getSuccessRate(): number {
    if (this.statistics.connectionAttempts === 0) return 0;
    return Math.round((this.statistics.successfulConnections / this.statistics.connectionAttempts) * 100);
  }

  resetStatistics() {
    this.statistics = {
      messagesSent: 0,
      messagesReceived: 0,
      errors: 0,
      connectionAttempts: 0,
      successfulConnections: 0,
      connectionTime: this.statistics.connectionTime,
      uptime: this.statistics.uptime
    };
    this.saveSettings();
    this.addLog('info', 'Estadísticas reseteadas');
  }

  // ========== LOGS ==========

  clearLogs() {
    this.logs = [];
    this.addLog('info', 'Logs limpiados');
  }

  private addLog(type: LogEntry['type'], message: string) {
    const log: LogEntry = {
      timestamp: new Date(),
      type,
      message
    };

    this.logs.unshift(log);

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }

    console.log(`[${type.toUpperCase()}] ${message}`);
  }

  getLogIcon(type: string): string {
    switch (type) {
      case 'success': return 'checkmark-circle';
      case 'error': return 'close-circle';
      case 'warning': return 'alert-circle';
      default: return 'information-circle';
    }
  }

  getLogColor(type: string): string {
    switch (type) {
      case 'success': return 'success';
      case 'error': return 'danger';
      case 'warning': return 'warning';
      default: return 'medium';
    }
  }

  formatTime(date: Date): string {
    return date.toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }
}