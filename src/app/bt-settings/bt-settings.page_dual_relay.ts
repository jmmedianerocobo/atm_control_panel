import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { 
  IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonButton, IonIcon, IonNote,
  IonContent, IonRefresher, IonRefresherContent, IonGrid, IonRow, IonCol, IonCard,
  IonCardHeader, IonCardTitle, IonCardSubtitle, IonCardContent, IonList, IonListHeader,
  IonItem, IonLabel, IonBadge, IonSpinner, IonToggle, IonInput, IonText,
  AlertController, ToastController, ToggleCustomEvent
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { bluetoothOutline, checkmarkCircle, closeCircle, syncOutline, refreshOutline,
  linkOutline, unlinkOutline, searchOutline, codeSlashOutline, flashOutline, statsChartOutline,
  sendOutline, settingsOutline, codeWorkingOutline, analyticsOutline, informationCircleOutline,
  terminalOutline, trashOutline, copyOutline, documentTextOutline, listOutline } from 'ionicons/icons';

import { BluetoothService, BluetoothDevice } from '../services/bluetooth.service_dual_relay';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-bt-settings',
  templateUrl: './bt-settings.page.html',
  styleUrls: ['./bt-settings.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle,
    IonButton, IonIcon, IonContent, IonRefresher, IonRefresherContent, IonGrid, IonRow, IonCol,
    IonCard, IonCardHeader, IonCardTitle, IonCardSubtitle, IonCardContent, IonList, IonListHeader,
    IonItem, IonLabel, IonBadge, IonSpinner, IonToggle, IonInput, IonText, IonNote
  ]
})
export class BtSettingsPage implements OnInit, OnDestroy {

  // Estado
  isConnected = false;
  isConnecting = false;
  isScanning = false;

  // Datos
  pairedDevices: BluetoothDevice[] = [];
  unpairedDevices: BluetoothDevice[] = [];
  connectedDevice: BluetoothDevice | null = null;

  // Log
  receivedDataLog: string[] = [];
  maxLogLines = 100;

  // Estadísticas
  stats = {
    dataReceivedCount: 0,
    lastDataReceivedTime: null as Date | null,
    uptime: 0
  };

  // Opciones
  simulationEnabled = false;
  autoReconnect = true;

  private subscriptions: Subscription[] = [];

  constructor(
    private bluetoothService: BluetoothService,
    private alertController: AlertController,
    private toastController: ToastController
  ) {
    // Registrar iconos
    addIcons({
      'bluetooth-outline': bluetoothOutline,
      'checkmark-circle': checkmarkCircle,
      'close-circle': closeCircle,
      'sync-outline': syncOutline,
      'refresh-outline': refreshOutline,
      'link-outline': linkOutline,
      'unlink-outline': unlinkOutline,
      'search-outline': searchOutline,
      'code-slash-outline': codeSlashOutline,
      'flash-outline': flashOutline,
      'stats-chart-outline': statsChartOutline,
      'send-outline': sendOutline,
      'settings-outline': settingsOutline,
      'code-working-outline': codeWorkingOutline,
      'analytics-outline': analyticsOutline,
      'information-circle-outline': informationCircleOutline,
      'terminal-outline': terminalOutline,
      'trash-outline': trashOutline,
      'copy-outline': copyOutline,
      'document-text-outline': documentTextOutline,
      'list-outline': listOutline
    });
  }

  ngOnInit() {
    this.setupSubscriptions();
    this.loadOptions();
  }

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  private setupSubscriptions() {
    this.subscriptions.push(
      this.bluetoothService.isConnected$.subscribe(status => this.isConnected = status)
    );
    this.subscriptions.push(
      this.bluetoothService.connectedDevice$.subscribe(device => this.connectedDevice = device)
    );
    this.subscriptions.push(
      this.bluetoothService.pairedDevices$.subscribe(devices => this.pairedDevices = devices)
    );
    this.subscriptions.push(
      this.bluetoothService.unpairedDevices$.subscribe(devices => this.unpairedDevices = devices)
    );
    this.subscriptions.push(
      this.bluetoothService.isScanning$.subscribe(status => this.isScanning = status)
    );
    this.subscriptions.push(
      this.bluetoothService.isSimulationEnabled$.subscribe(status => this.simulationEnabled = status)
    );
    this.subscriptions.push(
      this.bluetoothService.receivedData$.subscribe(data => this.addToLog(`📥 RX: ${data}`))
    );
  }

  private loadOptions() {
    const sim = localStorage.getItem('simulationEnabled');
    const auto = localStorage.getItem('autoReconnect');
    this.simulationEnabled = sim ? JSON.parse(sim) : false;
    this.autoReconnect = auto ? JSON.parse(auto) : true;
    this.bluetoothService.enableSimulation(this.simulationEnabled);
  }

  // ==========================
  // Getters para template
  // ==========================
  get connectionStatusText(): string {
    if (this.isConnecting) return 'Conectando...';
    if (this.isConnected) return `Conectado a ${this.connectedDevice?.name}`;
    return 'Desconectado';
  }

  get connectionStatusColor(): string {
    if (this.isConnecting) return 'warning';
    if (this.isConnected) return 'success';
    return 'medium';
  }

  get formattedUptime(): string {
    const seconds = this.stats.uptime;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  }

  get filteredPairedDevices(): BluetoothDevice[] {
    return this.pairedDevices.filter(d => d.name?.includes('HC-05') || d.name?.includes('HC-06'));
  }

  // ==========================
  // Métodos del componente
  // ==========================
  refresh(event?: any) {
    this.loadStats();
    if (event) event.target.complete();
    this.showToast('Actualizado', 'success');
  }

  disconnect() {
    this.bluetoothService.disconnect();
  }

  clearLog() {
    this.receivedDataLog = [];
    this.addToLog('🗑️ Log limpiado');
  }

  async copyLogToClipboard() {
    try {
      await navigator.clipboard.writeText(this.receivedDataLog.join('\n'));
      this.showToast('Log copiado al portapapeles', 'success');
    } catch {
      this.showToast('Error copiando log', 'danger');
    }
  }

  sendTestCommand() {
    this.bluetoothService.sendCommand('TEST:PING');
    this.addToLog('📤 TX: TEST:PING');
  }

  requestSTATS() {
    this.bluetoothService.sendCommand('D:');
    this.addToLog('📤 TX: D:');
  }

  sendCustomCommand(cmd: string) {
    if (!cmd.trim()) return this.showToast('Comando vacío', 'warning');
    this.bluetoothService.sendCommand(cmd.trim());
    this.addToLog(`📤 TX: ${cmd}`);
  }

  onSimulationChange(event: ToggleCustomEvent) {
    this.simulationEnabled = event.detail.checked;
    this.bluetoothService.enableSimulation(this.simulationEnabled);
    localStorage.setItem('simulationEnabled', JSON.stringify(this.simulationEnabled));
  }

  onAutoReconnectChange(event: ToggleCustomEvent) {
    this.autoReconnect = event.detail.checked;
    localStorage.setItem('autoReconnect', JSON.stringify(this.autoReconnect));
  }

  updateStats() {
    this.stats = this.bluetoothService.getStats();
  }

  pairAndConnect(device: BluetoothDevice) {
    this.bluetoothService.connect(device);
  }

  scanForUnpaired() {
    this.bluetoothService.startScan();
  }

  // ==========================
  // Log
  // ==========================
  private addToLog(message: string) {
    const ts = new Date().toLocaleTimeString();
    this.receivedDataLog.unshift(`[${ts}] ${message}`);
    if (this.receivedDataLog.length > this.maxLogLines) this.receivedDataLog.pop();
  }

  private loadStats() {
    this.stats = this.bluetoothService.getStats();
  }

  private async showToast(msg: string, color: string = 'primary') {
    const toast = await this.toastController.create({ message: msg, duration: 2000, color });
    await toast.present();
  }

}

