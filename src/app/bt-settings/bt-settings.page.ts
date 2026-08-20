import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BluetoothService, BluetoothDevice } from '../services/bluetooth.service';
import { ToastService } from '../services/toast.service';

import {
  IonHeader, IonToolbar, IonTitle,
  IonContent, IonButtons, IonBackButton,
  IonButton, IonLabel, IonItem, IonList,
  IonChip, IonSpinner, IonIcon,
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
    IonChip, IonSpinner, IonIcon,
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

  constructor(
    public bt: BluetoothService,
    private alertController: AlertController,
    private toast: ToastService,
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
        await this.toast.present(`${removed} dispositivo(s) eliminado(s) correctamente`, 'success');
      } else {
        await this.toast.present(
          `${removed} eliminado(s), ${failed.length} fallaron (${failed.map(f => f.device.name).join(', ')})`,
          'danger',
        );
      }
    } catch (err) {
      await this.toast.present(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      this.isUnpairingAll = false;
    }
  }

  // ── Diagnóstico ─────────────────────────────────────────────────
  // Antes, diagnosticar un fallo de conexión en campo exigía tener el móvil
  // enchufado por adb y leer logcat en directo — inviable para el usuario
  // final. bt.logEntries$ ya registra todo lo interesante (conexión,
  // reintentos, timeouts...) desde hace tiempo, pero no había ninguna forma
  // de sacarlo de la app. Este botón vuelca las últimas entradas en texto
  // plano y las copia al portapapeles, con 3 niveles de fallback: la mayoría
  // de WebView Android modernas soportan navigator.clipboard.writeText()
  // desde un gesto de usuario (este click lo es), pero si esa API no
  // estuviera disponible o fallara, se intenta el truco clásico de
  // execCommand('copy'), y si ni eso funciona, se muestra el texto en un
  // cuadro de diálogo para copiarlo a mano en vez de fallar en silencio.
  //
  // Fix: en la práctica, en este WebView concreto navigator.clipboard.
  // writeText() se queda "fantasma" — ni resuelve ni rechaza nunca, exacto
  // el mismo patrón que bluetoothSerial.write()/connect() (ver writeBytes()/
  // connect() en bluetooth.service.ts). Sin timeout, un simple botón de
  // copiar diagnóstico se quedaba colgado en silencio para siempre.
  // tryClipboardApi() ahora compite con un timeout corto para no bloquear
  // nunca los otros dos niveles de fallback.
  async copyDiagnostics(): Promise<void> {
    const text = this.buildDiagnosticsText();

    if (await this.tryClipboardApi(text)) {
      await this.toast.present('Diagnóstico copiado al portapapeles', 'success');
      return;
    }
    if (this.tryLegacyCopy(text)) {
      await this.toast.present('Diagnóstico copiado al portapapeles', 'success');
      return;
    }
    await this.showDiagnosticsForManualCopy(text);
  }

  private buildDiagnosticsText(): string {
    const device = this.bt.connectedDevice$.value;
    const header = [
      'ATM Control Panel — diagnóstico Bluetooth',
      `Generado: ${new Date().toLocaleString()}`,
      `Estado: ${this.statusTitle}`,
      device ? `Dispositivo: ${device.name} (${device.address})` : 'Dispositivo: ninguno',
      `Protocolo Arduino: v${this.bt.arduinoProtocolVersion$.value}`,
      '',
    ].join('\n');

    // logEntries$ guarda lo más nuevo primero; para un diagnóstico se lee
    // mejor en orden cronológico (más antiguo arriba).
    const entries = this.bt.logEntries$.value;
    const body = entries.length === 0
      ? '(sin entradas de log todavía — conecta primero)'
      : entries.slice().reverse().map(e => {
          const time = e.ts.toLocaleTimeString();
          const data = e.data !== undefined ? ' ' + this.safeStringify(e.data) : '';
          return `${time} [${e.level.toUpperCase()}][${e.category}] ${e.msg}${data}`;
        }).join('\n');

    return header + body;
  }

  private safeStringify(data: unknown): string {
    try { return JSON.stringify(data); } catch { return String(data); }
  }

  private async tryClipboardApi(text: string): Promise<boolean> {
    if (!navigator.clipboard?.writeText) return false;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('CLIPBOARD_TIMEOUT'));
        }, 1500);

        navigator.clipboard.writeText(text).then(
          () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); },
          (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
        );
      });
      return true;
    } catch {
      return false;
    }
  }

  private tryLegacyCopy(text: string): boolean {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }

  private async showDiagnosticsForManualCopy(text: string): Promise<void> {
    const alert = await this.alertController.create({
      header: 'Diagnóstico (copia manual)',
      message: 'No se pudo copiar automáticamente. Selecciona el texto y cópialo a mano:',
      inputs: [{ type: 'textarea', value: text, name: 'diagnostics' }],
      buttons: ['Cerrar'],
    });
    await alert.present();
  }

  // ── Helpers ────────────────────────────────────────────────────
  // Identificación por dirección (no por nombre): evita falsos positivos si
  // hay dos dispositivos emparejados con el mismo nombre (p.ej. "HC-05").
  isActiveDevice(device: BluetoothDevice): boolean {
    return this.isConnected$.value &&
           device.address === this.bt.connectedDevice$.value?.address;
  }
}