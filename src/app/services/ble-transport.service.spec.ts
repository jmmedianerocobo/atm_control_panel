import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { BleTransportService, BluetoothDevice } from './ble-transport.service';

// ================================================================
// Helpers de framing — replican EXACTAMENTE el CRC16/formato de trama del
// propio transporte (ver crc16_ccitt()/buildFrame() en ble-transport.
// service.ts) para poder construir, en los tests, respuestas "del Arduino"
// válidas que el parser RX real acepte.
// ================================================================
function crc16Ccitt(buf: Uint8Array): number {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= (buf[i] << 8) & 0xFFFF;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      else crc = (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

const SOF1 = 0xAA, SOF2 = 0x55, VER = 0x01, ACK_BASE = 0x80;

function buildFrame(type: number, seq: number, payload: number[] = []): Uint8Array {
  const len = payload.length;
  const out = new Uint8Array(2 + 1 + 1 + 2 + 2 + len + 2);
  let o = 0;
  out[o++] = SOF1; out[o++] = SOF2; out[o++] = VER;
  out[o++] = type & 0xFF;
  out[o++] = seq & 0xFF; out[o++] = (seq >> 8) & 0xFF;
  out[o++] = len & 0xFF; out[o++] = (len >> 8) & 0xFF;
  payload.forEach(b => out[o++] = b & 0xFF);
  const crc = crc16Ccitt(out.slice(2, 2 + 1 + 1 + 2 + 2 + len));
  out[o++] = crc & 0xFF; out[o++] = (crc >> 8) & 0xFF;
  return out;
}

/** Respuesta ACK "del Arduino" para cmdType/seq — result=0 es RES_OK. */
function buildAck(cmdType: number, seq: number, result: number): Uint8Array {
  return buildFrame(ACK_BASE | (cmdType & 0x7F), seq, [result]);
}

const TEST_DEVICE: BluetoothDevice = { name: 'TEST', address: '00:00:00:00:00:01' };

describe('BleTransportService', () => {
  let service: BleTransportService;
  let mockBt: any;
  let rawDataCallback: ((data: any) => void) | null;

  beforeEach(() => {
    rawDataCallback = null;
    mockBt = {
      connect: jasmine.createSpy('connect'),
      disconnect: jasmine.createSpy('disconnect').and.callFake((ok: Function) => ok()),
      write: jasmine.createSpy('write'),
      subscribeRawData: jasmine.createSpy('subscribeRawData').and.callFake((cb: (d: any) => void) => {
        rawDataCallback = cb;
      }),
      unsubscribeRawData: jasmine.createSpy('unsubscribeRawData'),
      unsubscribe: jasmine.createSpy('unsubscribe'),
      list: jasmine.createSpy('list'),
      unpair: jasmine.createSpy('unpair'),
      discoverUnpaired: jasmine.createSpy('discoverUnpaired'),
    };
    (globalThis as any).bluetoothSerial = mockBt;

    TestBed.configureTestingModule({});
    service = TestBed.inject(BleTransportService);
  });

  afterEach(() => {
    delete (globalThis as any).bluetoothSerial;
  });

  /** Conecta con el mock respondiendo con éxito de inmediato y deja
   *  capturado el callback de subscribeRawData para poder simular tramas
   *  entrantes del Arduino en los tests. Debe llamarse dentro de fakeAsync. */
  function connectMock(): void {
    mockBt.connect.and.callFake((_addr: string, ok: Function) => ok());
    service.connect(TEST_DEVICE);
    tick(600); // supera la espera de asentamiento de 500ms tras conectar
  }

  function feedAck(cmdType: number, seq: number, result = 0) {
    rawDataCallback!(buildAck(cmdType, seq, result).buffer);
  }

  it('se crea', () => {
    expect(service).toBeTruthy();
  });

  describe('sendCmd()', () => {
    it('resuelve cuando llega un ACK OK', fakeAsync(() => {
      connectMock();
      mockBt.write.and.callFake((_buf: any, ok: Function) => ok());

      let resolved = false;
      service.sendCmd(0x03, undefined, 3000, 'low', 1).then(() => resolved = true);
      tick(0);
      feedAck(0x03, 1, 0);
      tick(0);

      expect(resolved).toBeTrue();
    }));

    it('rechaza con el código decodificado cuando el ACK indica error', fakeAsync(() => {
      connectMock();
      mockBt.write.and.callFake((_buf: any, ok: Function) => ok());

      let error: any = null;
      service.sendCmd(0x03, undefined, 3000, 'low', 1).catch(e => error = e);
      tick(0);
      feedAck(0x03, 1, 2); // RES_BAD_VAL
      tick(0);

      expect(error).toBe('BAD_VALUE');
    }));

    it('WRITE_TIMEOUT: si bluetoothSerial.write() no llama a ningún callback, rechaza pasado el timeout en vez de colgarse para siempre', fakeAsync(() => {
      connectMock();
      // El mock de write() no invoca ni éxito ni error — reproduce el bug
      // real de "socket fantasma" que motivó este fix.
      mockBt.write.and.callFake(() => {});

      let error: any = null;
      service.sendCmd(0x03, undefined, 3000, 'low', 1).catch(e => error = e);
      // El WRITE_TIMEOUT (3000ms, fijo dentro de writeBytes()) dispara el
      // único intento configurado, pero sendCmdWithRetry aplica su pausa de
      // backoff (150ms) incluso al agotarse el último intento antes de
      // relanzar — hay que superar también esa espera, si no la promesa
      // sigue pendiente al terminar el test y contamina el siguiente.
      tick(3200);

      expect(String(error)).toContain('WRITE_TIMEOUT');
    }));

    it('ACK timeout: si el write sale pero nunca llega respuesta, rechaza pasado el timeout configurado', fakeAsync(() => {
      connectMock();
      mockBt.write.and.callFake((_buf: any, ok: Function) => ok());

      let error: any = null;
      service.sendCmd(0x03, undefined, 2000, 'low', 1).catch(e => error = e);
      tick(2200); // 2000ms de ACK timeout + backoff de 150ms tras el último intento

      expect(error).toBe('ACK timeout');
    }));

    it('NO reintenta cuando el ACK indica un error BAD_* (solo un write)', fakeAsync(() => {
      connectMock();
      mockBt.write.and.callFake((_buf: any, ok: Function) => ok());

      let error: any = null;
      service.sendCmd(0x05, undefined, 3000, 'high').catch(e => error = e); // 'high' → 3 intentos por defecto
      tick(0);
      feedAck(0x05, 1, 3); // RES_BAD_SIDE
      tick(0);

      expect(error).toBe('BAD_SIDE');
      expect(mockBt.write).toHaveBeenCalledTimes(1);
    }));

    it('SÍ reintenta tras un ACK timeout transitorio y puede acabar resolviendo en el 2º intento', fakeAsync(() => {
      connectMock();
      let writeCount = 0;
      mockBt.write.and.callFake((_buf: any, ok: Function) => { writeCount++; ok(); });

      let resolved = false;
      service.sendCmd(0x05, undefined, 3000, 'high').then(() => resolved = true);

      // 1er intento (no final): usa FAST_RETRY_TIMEOUT_MS=1500 — sin respuesta.
      tick(1600);
      // backoff tras el primer fallo (150ms).
      tick(160);
      // 2º intento — esta vez sí respondemos.
      feedAck(0x05, 2, 0);
      tick(0);

      expect(resolved).toBeTrue();
      expect(writeCount).toBe(2);
    }));
  });

  describe('cola de prioridad', () => {
    it('un comando "high" se cuela delante de un "low" todavía no despachado (pero no adelanta al que ya está en vuelo)', fakeAsync(() => {
      connectMock();
      const order: number[] = [];
      mockBt.write.and.callFake((buf: ArrayBuffer, ok: Function) => {
        order.push(new Uint8Array(buf)[3]); // byte de tipo de comando en la trama
        ok();
      });

      // low1 se despacha de inmediato (es el único en cola, sin nada que
      // adelantarle) — eso deja el worker ocupado esperando SU ack.
      service.sendCmd(0x10, undefined, 3000, 'low', 1).catch(() => {});
      // low2 y high llegan mientras low1 sigue en vuelo: high debe colarse
      // delante de low2 en la cola, no delante de low1 (ya imposible).
      service.sendCmd(0x11, undefined, 3000, 'low', 1).catch(() => {});
      service.sendCmd(0x20, undefined, 3000, 'high', 1).catch(() => {});
      tick(0);

      feedAck(0x10, 1, 0); tick(0); // libera el worker → procesa el siguiente (high)
      feedAck(0x20, 2, 0); tick(0); // → procesa el siguiente (low2)
      feedAck(0x11, 3, 0); tick(0);

      expect(order).toEqual([0x10, 0x20, 0x11]);
    }));

    it('un tercer comando "low" del mismo tipo se deduplica contra el que sigue esperando en cola (no contra el que ya está en vuelo)', fakeAsync(() => {
      connectMock();
      mockBt.write.and.callFake((_buf: any, ok: Function) => ok());

      let resolvedCount = 0;
      // El primero se despacha de inmediato (deja el worker ocupado
      // esperando SU ACK, así que ya no cuenta para la deduplicación — ha
      // salido de cmdQueue). El segundo sí queda esperando turno en cola.
      // El tercero, encolado mientras el segundo sigue ahí sin enviar, se
      // deduplica contra ÉL.
      service.sendCmd(0x30, undefined, 3000, 'low', 1).then(() => resolvedCount++);
      service.sendCmd(0x30, undefined, 3000, 'low', 1).then(() => resolvedCount++);
      service.sendCmd(0x30, undefined, 3000, 'low', 1).then(() => resolvedCount++);
      tick(0);

      feedAck(0x30, 1, 0); tick(0); // libera el worker → despacha el segundo
      feedAck(0x30, 2, 0); tick(0);

      expect(mockBt.write).toHaveBeenCalledTimes(2);
      expect(resolvedCount).toBe(3); // los tres se resuelven: 2 de verdad + 1 deduplicado al vuelo
    }));
  });

  describe('connect()', () => {
    it('CONNECT_TIMEOUT: si bluetoothSerial.connect() no llama a ningún callback, rechaza pasado el timeout en vez de colgarse para siempre', fakeAsync(() => {
      mockBt.connect.and.callFake(() => {}); // "fantasma" — no llama a nada

      let error: any = null;
      service.connect(TEST_DEVICE).catch(e => error = e);
      tick(30100); // supera CONNECT_TIMEOUT_MS (30000)

      expect(String(error)).toContain('CONNECT_TIMEOUT');
    }));

    it('ignora con seguridad un callback nativo tardío que llega después de que el propio timeout ya haya resuelto', fakeAsync(() => {
      let lateSuccess: Function = () => {};
      mockBt.connect.and.callFake((_addr: string, ok: Function) => { lateSuccess = ok; });

      let error: any = null;
      let resolved = false;
      service.connect(TEST_DEVICE).then(() => resolved = true).catch(e => error = e);
      tick(30100);

      expect(String(error)).toContain('CONNECT_TIMEOUT');

      // El callback nativo tardío no debe lanzar ni cambiar el resultado ya asentado.
      expect(() => lateSuccess()).not.toThrow();
      tick(0);
      expect(resolved).toBeFalse();
    }));
  });

  describe('heartbeat', () => {
    it('tras 3 PING seguidos sin respuesta, emite reconnectRequested$ (no reconecta él solo)', fakeAsync(() => {
      connectMock();
      // En uso real, adaptToProtocolVersion() la llama la fachada al final
      // de connect() (o el propio transporte al recibir EVT_BOOT) — aquí no
      // hay fachada, así que se arranca el heartbeat a mano.
      service.adaptToProtocolVersion();
      // El write "sale" con éxito, pero nunca llega ACK — cada PING del
      // heartbeat acaba en timeout, igual que un enlace "fantasma" real.
      mockBt.write.and.callFake((_buf: any, ok: Function) => ok());

      let requested = false;
      service.reconnectRequested$.subscribe(() => requested = true);

      for (let i = 0; i < 3; i++) {
        tick(15000); // HEARTBEAT_INTERVAL_MS
        tick(3200);  // ACK timeout del PING (3000ms) + backoff tras el último intento
      }

      expect(requested).toBeTrue();
      discardPeriodicTasks(); // el heartbeat sigue vivo — no se ha desconectado
    }));
  });
});
