import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BluetoothService, BluetoothDevice } from '../services/bluetooth.service';

import {
  IonHeader, IonToolbar, IonTitle,
  IonContent, IonButtons, IonBackButton,
  IonButton, IonLabel, IonItem, IonList,
  IonChip, IonSpinner, IonIcon, IonToast,
  AlertController,
} from '@ionic/angular/standalone';

@Component({
  selector: 'app-bt-settings',
  templateUrl: './bt-settings.page.html',
  styleUrls: ['./bt-settings.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    IonHeader, IonToolbar, IonTitle,
    IonContent, IonButtons, IonBackButton,
    IonButton, IonLabel, IonItem, IonList,
    IonChip, IonSpinner, IonIcon, IonToast,
  ],
})
export class BtSettingsPage implements OnInit {

  isConnected$     = this.bt.isConnected$;
  pairedDevices$   = this.bt.pairedDevices$;
  unpairedDevices$ = this.bt.unpairedDevices$;
  // Fix: nombre/dirección del dispositivo conectado leídos del servicio
  // (sobrevive a que esta página se destruya/recree al navegar fuera y
  // volver), en vez de guardados en campos locales del componente que se
  // perdían en cada recreación aunque la conexión real siguiera viva.
  connectedDevice$ = this.bt.connectedDevice$;

  isConnecting = false;
  isScanning   = false;
  isUnpairingAll = false;

  showSuccessToast = false;
  successMessage   = '';
  showErrorToast   = false;
  errorMessage     = '';

  constructor(
    public bt: BluetoothService,
    private alertController: AlertController,
  ) {}

  ngOnInit() {
    this.bt.loadPairedDevices().catch(err =>
      console.error('Error cargando dispositivos emparejados:', err)
    );
  }

  // ── Estado principal ────────────────────────────────────────────
  get statusClass(): string {
    if (this.isConnected$.value) return 'connected';
    if (this.isConnecting)       return 'connecting';
    return 'disconnected';
  }

  get statusTitle(): string {
    if (this.isConnected$.value) return 'Conectado';
    if (this.isConnecting)       return 'Conectando…';
    return 'Desconectado';
  }

  get statusSubtitle(): string {
    const connectedDevice = this.bt.connectedDevice$.value;
    if (this.isConnected$.value && connectedDevice?.name)
      return `${connectedDevice.name} · listo`;
    if (this.isConnected$.value) return 'Dispositivo listo';
    if (this.isConnecting)       return 'Conectando con el dispositivo…';
    if (this.isScanning)         return 'Buscando dispositivos…';
    return 'Ningún dispositivo conectado';
  }

  // ── Conexión ────────────────────────────────────────────────────
  async toggleConnection() {
    if (this.isConnected$.value) {
      await this.disconnect();
      return;
    }
    await this.scan();
  }

  async connectTo(device: BluetoothDevice) {
    try {
      this.isConnecting = true;
      // Se pasa el objeto completo (no solo la address) para que el servicio
      // conserve el nombre real del dispositivo internamente y lo publique
      // en connectedDevice$ (ver bluetooth.service.ts) — ya no hace falta
      // guardarlo aquí también.
      await this.bt.connect(device);
    } catch (err) {
      console.error('Error al conectar:', err);
    } finally {
      this.isConnecting = false;
    }
  }

  async disconnect() {
    await this.bt.disconnect();
  }

  // ── Escaneo ────────────────────────────────────────────────────
  // Secuencial (no Promise.all): así, si scanForUnpaired() falla (típico en
  // Android sin permisos de ubicación concedidos), no se pierde ni se
  // enmascara el refresco ya exitoso de los dispositivos emparejados, y el
  // log deja claro cuál de las dos operaciones ha fallado.
  async scan() {
    this.isScanning = true;
    try {
      await this.bt.loadPairedDevices().catch(err => {
        console.error('Error cargando emparejados:', err);
      });
      await this.bt.scanForUnpaired();
    } catch (err) {
      console.error('Error escaneando no emparejados:', err);
    } finally {
      this.isScanning = false;
    }
  }

  async tryConnect(device: BluetoothDevice) {
    await this.connectTo(device);
  }

  // ── Eliminar emparejados ───────────────────────────────────────
  // Acción destructiva/difícil de deshacer (hay que volver a emparejar a
  // mano cada dispositivo desde Ajustes del sistema), así que se confirma
  // antes — mismo patrón que las calibraciones de auto-config.page.ts.
  async confirmUnpairAll(): Promise<void> {
    const count = this.pairedDevices$.value.length;
    if (count === 0) return;

    const alert = await this.alertController.create({
      header: 'Eliminar todos los emparejados',
      message:
        `Se eliminará el emparejamiento de los ${count} dispositivo(s) Bluetooth ` +
        'listados. Tendrás que volver a emparejarlos manualmente (desde Ajustes ' +
        'del sistema o "Iniciar búsqueda") para volver a usarlos. Si hay uno ' +
        'conectado ahora mismo, se desconectará primero.',
      backdropDismiss: false,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Eliminar todos', role: 'destructive', handler: () => void this.runUnpairAll() },
      ],
    });
    await alert.present();
  }

  private async runUnpairAll(): Promise<void> {
    if (this.isUnpairingAll) return;
    this.isUnpairingAll = true;

    try {
      const { removed, failed } = await this.bt.unpairAllPaired();
      if (failed.length === 0) {
        this.successMessage = `${removed} dispositivo(s) eliminado(s) correctamente`;
        this.showSuccessToast = true;
      } else {
        this.errorMessage = `${removed} eliminado(s), ${failed.length} fallaron ` +
          `(${failed.map(f => f.device.name).join(', ')})`;
        this.showErrorToast = true;
      }
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.showErrorToast = true;
    } finally {
      this.isUnpairingAll = false;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────
  // Identificación por dirección (no por nombre): evita falsos positivos si
  // hay dos dispositivos emparejados con el mismo nombre (p.ej. "HC-05").
  isActiveDevice(device: BluetoothDevice): boolean {
    return this.isConnected$.value &&
           device.address === this.bt.connectedDevice$.value?.address;
  }
}