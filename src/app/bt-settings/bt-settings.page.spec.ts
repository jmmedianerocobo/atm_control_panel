import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { AlertController } from '@ionic/angular/standalone';

import { BtSettingsPage } from './bt-settings.page';
import { BluetoothService, BluetoothDevice, LogEntry } from '../services/bluetooth.service';

/** Doble de BluetoothService: solo la superficie que usa esta página. */
class FakeBluetoothService {
  isConnected$     = new BehaviorSubject<boolean>(false);
  pairedDevices$   = new BehaviorSubject<BluetoothDevice[]>([]);
  unpairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);
  connectedDevice$ = new BehaviorSubject<BluetoothDevice | null>(null);
  logEntries$              = new BehaviorSubject<LogEntry[]>([]);
  arduinoProtocolVersion$  = new BehaviorSubject<number>(0);

  connect           = jasmine.createSpy('connect').and.resolveTo(undefined);
  disconnect        = jasmine.createSpy('disconnect').and.resolveTo(undefined);
  loadPairedDevices = jasmine.createSpy('loadPairedDevices').and.resolveTo(undefined);
  scanForUnpaired   = jasmine.createSpy('scanForUnpaired').and.resolveTo(undefined);
  unpairAllPaired   = jasmine.createSpy('unpairAllPaired').and.resolveTo({ removed: 0, failed: [] });
}

/** Mismo doble de AlertController que en auto-config.page.spec.ts: distingue
 *  diálogos de confirmación (llevan `header`) de toasts (no lo llevan). */
class FakeAlertController {
  created: any[] = [];

  create = jasmine.createSpy('create').and.callFake(async (opts: any) => {
    const alert = {
      opts,
      present: jasmine.createSpy('present').and.resolveTo(undefined),
      dismiss: jasmine.createSpy('dismiss').and.resolveTo(undefined),
    };
    this.created.push(alert);
    return alert;
  });

  get toasts()  { return this.created.filter(a => !a.opts.header); }
  get dialogs() { return this.created.filter(a => a.opts.header); }

  /** Pulsa el botón de ese `role` en el ÚLTIMO diálogo de confirmación
   *  creado, y da tiempo real de cola de eventos a que su handler
   *  fire-and-forget termine (ver misma nota en auto-config.page.spec.ts). */
  async pressButton(role: string): Promise<void> {
    const dialog = this.dialogs[this.dialogs.length - 1];
    const btn = dialog.opts.buttons.find((b: any) => typeof b === 'object' && b.role === role);
    btn?.handler?.();
    await new Promise(r => setTimeout(r, 0));
  }
}

const DEV_A: BluetoothDevice = { name: 'ATM-01', address: 'AA:BB:CC:00:00:01' };
const DEV_B: BluetoothDevice = { name: 'ATM-02', address: 'AA:BB:CC:00:00:02' };

describe('BtSettingsPage', () => {
  let component: BtSettingsPage;
  let bt: FakeBluetoothService;
  let alertCtrl: FakeAlertController;

  beforeEach(() => {
    bt = new FakeBluetoothService();
    alertCtrl = new FakeAlertController();
    TestBed.configureTestingModule({
      providers: [
        { provide: BluetoothService, useValue: bt },
        { provide: AlertController, useValue: alertCtrl },
      ],
    });
    component = TestBed.createComponent(BtSettingsPage).componentInstance;
  });

  it('se crea y renderiza la plantilla sin errores', () => {
    const fixture = TestBed.createComponent(BtSettingsPage);
    expect(() => fixture.detectChanges()).not.toThrow();
  });

  // ================================================================
  describe('estado (statusClass/statusTitle/statusSubtitle)', () => {
    it('conectado: usa el nombre del dispositivo si lo tiene', () => {
      bt.isConnected$.next(true);
      bt.connectedDevice$.next(DEV_A);
      expect(component.statusClass).toBe('connected');
      expect(component.statusTitle).toBe('Conectado');
      expect(component.statusSubtitle).toBe('ATM-01 · listo');
    });

    it('conectando', () => {
      component.isConnecting = true;
      expect(component.statusClass).toBe('connecting');
      expect(component.statusSubtitle).toContain('Conectando');
    });

    it('escaneando (sin conectar ni conectando)', () => {
      component.isScanning = true;
      expect(component.statusClass).toBe('disconnected');
      expect(component.statusSubtitle).toContain('Buscando');
    });

    it('desconectado, sin actividad', () => {
      expect(component.statusSubtitle).toBe('Ningún dispositivo conectado');
    });
  });

  // ================================================================
  describe('toggleConnection()', () => {
    it('si está conectado, desconecta en vez de escanear', async () => {
      bt.isConnected$.next(true);
      await component.toggleConnection();
      expect(bt.disconnect).toHaveBeenCalled();
      expect(bt.loadPairedDevices).not.toHaveBeenCalled();
    });

    it('si no está conectado, escanea', async () => {
      await component.toggleConnection();
      expect(bt.loadPairedDevices).toHaveBeenCalled();
      expect(bt.scanForUnpaired).toHaveBeenCalled();
    });
  });

  // ================================================================
  describe('connectTo()', () => {
    it('activa isConnecting mientras conecta y lo libera al terminar (éxito)', async () => {
      let resolveConnect!: () => void;
      bt.connect.and.callFake(() => new Promise<void>(res => { resolveConnect = res; }));

      const p = component.connectTo(DEV_A);
      expect(component.isConnecting).toBeTrue();
      resolveConnect();
      await p;

      expect(bt.connect).toHaveBeenCalledWith(DEV_A);
      expect(component.isConnecting).toBeFalse();
    });

    it('libera isConnecting también si connect() falla (el error se registra, no se propaga)', async () => {
      bt.connect.and.callFake(() => Promise.reject(new Error('sin ACK')));
      await component.connectTo(DEV_A);
      expect(component.isConnecting).toBeFalse();
    });
  });

  // ================================================================
  describe('scan()', () => {
    it('libera isScanning aunque scanForUnpaired() falle (típico sin permisos de ubicación)', async () => {
      bt.scanForUnpaired.and.callFake(() => Promise.reject(new Error('sin permisos')));
      await component.scan();
      expect(component.isScanning).toBeFalse();
    });

    it('si loadPairedDevices() falla, igualmente intenta scanForUnpaired() (no se enmascara ni corta la operación)', async () => {
      bt.loadPairedDevices.and.callFake(() => Promise.reject(new Error('fail')));
      await component.scan();
      expect(bt.scanForUnpaired).toHaveBeenCalled();
      expect(component.isScanning).toBeFalse();
    });
  });

  // ================================================================
  describe('confirmUnpairAll()', () => {
    it('con la lista de emparejados vacía, no abre ningún diálogo', async () => {
      bt.pairedDevices$.next([]);
      await component.confirmUnpairAll();
      expect(alertCtrl.dialogs.length).toBe(0);
    });

    it('al confirmar, llama a unpairAllPaired() y muestra éxito con el recuento', async () => {
      bt.pairedDevices$.next([DEV_A, DEV_B]);
      bt.unpairAllPaired.and.resolveTo({ removed: 2, failed: [] });

      await component.confirmUnpairAll();
      await alertCtrl.pressButton('destructive');

      expect(bt.unpairAllPaired).toHaveBeenCalled();
      expect(alertCtrl.toasts[0].opts.message).toContain('2 dispositivo(s) eliminado(s)');
    });

    it('si algunos fallan, muestra un toast de error con sus nombres', async () => {
      bt.pairedDevices$.next([DEV_A]);
      bt.unpairAllPaired.and.resolveTo({ removed: 0, failed: [{ device: DEV_A, error: 'x' }] });

      await component.confirmUnpairAll();
      await alertCtrl.pressButton('destructive');

      expect(alertCtrl.toasts[0].opts.message).toContain('fallaron (ATM-01)');
    });

    it('al cancelar, no llama a unpairAllPaired()', async () => {
      bt.pairedDevices$.next([DEV_A]);
      await component.confirmUnpairAll();
      await alertCtrl.pressButton('cancel');
      expect(bt.unpairAllPaired).not.toHaveBeenCalled();
    });
  });

  // ================================================================
  describe('isActiveDevice()', () => {
    it('identifica por address, no por nombre (evita falsos positivos con nombres duplicados)', () => {
      bt.isConnected$.next(true);
      bt.connectedDevice$.next(DEV_A);
      expect(component.isActiveDevice(DEV_A)).toBeTrue();
      expect(component.isActiveDevice({ name: DEV_A.name, address: 'OTRA' })).toBeFalse();
    });

    it('sin conexión, ningún dispositivo es el activo', () => {
      bt.isConnected$.next(false);
      bt.connectedDevice$.next(DEV_A);
      expect(component.isActiveDevice(DEV_A)).toBeFalse();
    });
  });

  // ================================================================
  describe('copyDiagnostics() — los 3 niveles de fallback', () => {
    let writeTextSpy: jasmine.Spy;
    let originalClipboard: any;

    beforeEach(() => {
      originalClipboard = (navigator as any).clipboard;
      writeTextSpy = jasmine.createSpy('writeText');
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: writeTextSpy }, configurable: true });
      spyOn(document, 'execCommand').and.returnValue(false); // por defecto, sin fallback legado
    });

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
    });

    it('nivel 1 (Clipboard API) OK: copia y muestra éxito, sin caer a los otros niveles', async () => {
      writeTextSpy.and.resolveTo(undefined);
      await component.copyDiagnostics();
      expect(writeTextSpy).toHaveBeenCalled();
      expect(document.execCommand).not.toHaveBeenCalled();
      expect(alertCtrl.toasts[0].opts.message).toContain('copiado al portapapeles');
    });

    it('nivel 1 "fantasma" (no resuelve ni rechaza nunca): hace timeout a los 1500ms y cae al nivel 2 (regresión del mismo patrón de bluetoothSerial.write() ya visto)', fakeAsync(() => {
      writeTextSpy.and.returnValue(new Promise(() => {})); // nunca se asienta
      (document.execCommand as jasmine.Spy).and.returnValue(true);

      component.copyDiagnostics();
      tick(1600);

      expect(document.execCommand).toHaveBeenCalledWith('copy');
      expect(alertCtrl.toasts[0].opts.message).toContain('copiado al portapapeles');
    }));

    it('nivel 1 y 2 fallan: muestra el diálogo de copia manual (nivel 3)', async () => {
      writeTextSpy.and.callFake(() => Promise.reject(new Error('denied')));
      // execCommand ya devuelve false por el beforeEach

      await component.copyDiagnostics();

      expect(alertCtrl.dialogs.length).toBe(1);
      expect(alertCtrl.dialogs[0].opts.header).toBe('Diagnóstico (copia manual)');
    });

    it('si no existe la Clipboard API en absoluto, salta directo al nivel 2', async () => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      (document.execCommand as jasmine.Spy).and.returnValue(true);

      await component.copyDiagnostics();

      expect(alertCtrl.toasts[0].opts.message).toContain('copiado al portapapeles');
    });
  });
});
