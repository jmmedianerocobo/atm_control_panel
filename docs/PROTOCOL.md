# Protocolo binario App ↔ Arduino

Fuente de verdad **compartida** entre `atm-control-panel` (app) y
`atm-firmware` (Arduino) — un cambio aquí implica cambiar los dos lados.
Vive duplicado en ambos repos porque son proyectos separados; si diverge,
este fichero es el que manda (contrastado línea a línea contra el `.ino`
real, no de memoria).

Transporte: **Bluetooth Classic (SPP)**, no BLE — por eso la app usa
`cordova-plugin-bluetooth-serial` en vez de las APIs BLE de Capacitor.

## Formato de trama

```
┌──────┬──────┬─────┬──────┬──────────┬──────────┬─────────┬──────┐
│ SOF1 │ SOF2 │ VER │ TYPE │ SEQ (LE) │ LEN (LE) │ PAYLOAD │ CRC  │
│ 0xAA │ 0x55 │  1B │  1B  │    2B    │    2B    │  LEN B  │  2B  │
└──────┴──────┴─────┴──────┴──────────┴──────────┴─────────┴──────┘
```

- `VER` = `0x01` (versión de *framing*, no confundir con `PROTOCOL_VERSION`
  del firmware — ver [nota de versionado](#dos-numeros-de-version-distintos)).
- `SEQ`: nº de secuencia de 16 bits, lo asigna quien envía; el `ACK`/evento
  de respuesta lo repite tal cual, así el emisor empareja respuesta↔petición.
- `LEN`: longitud del payload en bytes (puede ser 0).
- `CRC`: CRC16-CCITT (poly `0x1021`, init `0xFFFF`) sobre `VER..PAYLOAD`
  (SOF1/SOF2 no entran en el CRC).

Implementación de referencia (idéntica en ambos lados): `crc16_ccitt_update()`
en el `.ino`, `crc16Ccitt()`/`buildFrame()` en `ble-transport.service.ts`.

## Comandos (app → Arduino), `TYPE` en el rango `0x01-0x1F` salvo eventos

| Opcode | Nombre | Payload | Notas |
|---|---|---|---|
| `0x01` | `CMD_PING` | — | heartbeat; ver [reconexión](ARCHITECTURE.md#heartbeat-y-reconexión) |
| `0x02` | `CMD_SET_CONFIG` | 16B: `sourceMode`(u8) `mode`(u8) `thresholdCm`(u16) `hysteresisCm`(u16) `retardoEntradaDist`(u16,ms) `retardoSalidaDist`(u16,ms) `retardoEntradaTemp`(u16,ms) `activeTimeModo1`(u32,ms) | todo LE |
| `0x03` | `CMD_GET_STATUS` | — | dispara `EVT_STATUS` |
| `0x04` | `CMD_GET_RELAYSTAT` | — | dispara `EVT_RELAYSTAT` |
| `0x05` | `CMD_SET_ENABLE` | 2B: lado(`'L'`/`'R'` como u8) + bool(u8) | habilita/deshabilita un lado |
| `0x06` | `CMD_RESET_RELAYSTAT` | 0B (los dos lados) o 1B lado (v15+, un solo lado) | |
| `0x07` | `CMD_TEST_TRIGGER` | 1B: lado | solo válido en modo temporizado |
| `0x08` | `CMD_EMERGENCY_STOP` | — | corta ambas salidas ya |
| `0x09` | `CMD_CALIBRATE_LEVEL` | — | cero de presión (vacío) **+** plano MPU6050 a la vez |
| `0x0A` | `CMD_SET_HIGH_PRESSURE_CONFIG` | 6B: `alarmBar_x100`(u16) `resetBar_x100`(u16) `hardLimitBar_x100`(u16) | exige `reset < alarm < hardLimit ≤ 60` con margen mínimo `HP_MIN_GAP_BAR=0.5` |
| `0x0B` | `CMD_CALIBRATE_LEVEL_FULL` | — | punto "lleno"; requiere vacío ya calibrado |
| `0x0C` | `CMD_SET_TANK_GEOMETRY` | 4B: `tankHeightMm`(u16) `sensorLongitudinalOffsetMm`(i16, con signo) | |
| `0x0D` | `CMD_CALIBRATE_TILT_REF` | — | paso 1/2 de la autocalibración de `sensorLongitudinalOffsetMm` |
| `0x0E` | `CMD_CALIBRATE_TILT_APPLY` | — | paso 2/2; puede devolver `RES_BAD_VAL` (inclinación insuficiente) sin perder el paso 1 |
| `0x0F` | `CMD_CALIBRATE_HIGH_PRESSURE_ZERO` | — | invalida la referencia (`0x19`) calibrada antes |
| `0x19` | `CMD_CALIBRATE_HIGH_PRESSURE_REF` | 2B: `refBar_x100`(u16) | rango 0-60 bar; requiere el cero (`0x0F`) ya calibrado |

`0x10`-`0x18` están reservados para eventos (ver abajo) — por eso
`CMD_CALIBRATE_HIGH_PRESSURE_REF` salta directamente a `0x19`.

### Respuesta (ACK), app ← Arduino

`TYPE` de la respuesta = `ACK_BASE (0x80) | cmdType`. Payload: 1 byte con el
código de resultado:

| Valor | Nombre | Significado |
|---|---|---|
| `0` | `RES_OK` | aplicado |
| `1` | `RES_BAD_LEN` | longitud de payload incorrecta |
| `2` | `RES_BAD_VAL` | valor fuera de rango o precondición no cumplida |
| `3` | `RES_BAD_SIDE` | carácter de lado inválido (ni `'L'` ni `'R'`) |
| `4` | `RES_CRC_ERR` | CRC de la trama recibida no cuadra |

## Eventos (Arduino → app, no solicitados), `TYPE` en `0x10-0x18`

| Opcode | Nombre | Payload | Cuándo se manda |
|---|---|---|---|
| `0x10` | `EVT_BOOT` | 1B: `PROTOCOL_VERSION` | al arrancar el Arduino |
| `0x11` | `EVT_DIST` | 3B: lado(u8) + `cm`(u16) | ultrasonido, cambia la distancia |
| `0x12` | `EVT_RELAY` | 3B: lado(u8) + `on`(u8) + `modo`(u8, 0=continuo/1=temporizado) | cambia el estado de una salida |
| `0x13` | `EVT_SNAPSHOT` | 20B base + 7-9B extensión de nivel (ver abajo) | tras aplicar config, resumen completo |
| `0x14` | `EVT_STATUS` | 24B base + 7-9B extensión de nivel | respuesta a `CMD_GET_STATUS` |
| `0x15` | `EVT_RELAYSTAT` | 16B: `L.timeMs`(u32) `L.activations`(u32) `R.timeMs`(u32) `R.activations`(u32) | respuesta a `CMD_GET_RELAYSTAT` / tras resetear |
| `0x16` | `EVT_KEEPALIVE` | — | late si no ha habido tráfico reciente (gestionado internamente por el transporte, no llega a la fachada de dominio) |
| `0x17` | `EVT_LEVEL` | 8B: `pressurePsi_x100`(u16) `levelMm`(u16) `percent_x10`(u16) `tiltDeg`(u8) `valid`(u8) | periódico, nivel del depósito |
| `0x18` | `EVT_HIGH_PRESSURE` | 4B: `bar_x100`(u16) `sensorFault`(u8) `lockout`(u8) — v14+: +1B `calibBits` (bit0=cero calibrado, bit1=ref calibrada) | periódico + inmediato si cambia `fault`/`lockout` |

### Extensión de nivel dentro de `EVT_SNAPSHOT`/`EVT_STATUS`

**Ojo:** mismo dato, dos formatos distintos según de dónde venga —
`EVT_LEVEL` (arriba) NO tiene el mismo orden de campos que esta extensión, y
esta no incluye el porcentaje.

```
offset+0  levelMm            u16
offset+2  pressurePsi_x100   u16
offset+4  tiltDeg            u8
offset+5  valid              u8
offset+6  calibBits          u8   (bit0=vacío calibrado, bit1=lleno calibrado)
offset+7  tiltOffsetMm       i16  (v13+, opcional — si no llega, longitud < offset+9)
```

`offset` = 20 en `EVT_SNAPSHOT` (payload ≥ 27B para que llegue), 24 en
`EVT_STATUS` (payload ≥ 31B).

### Bloques base de `EVT_SNAPSHOT` / `EVT_STATUS`

`EVT_SNAPSHOT` (sin distancias, es un resumen de config aplicada):
```
0  Lrelay(u8) 1 Rrelay(u8) 2 enL(u8) 3 enR(u8) 4 sourceMode(u8) 5 mode(u8)
6  thresholdCm(u16) 8 hysteresisCm(u16) 10 retardoEntradaDist(u16)
12 retardoSalidaDist(u16) 14 retardoEntradaTemp(u16) 16 activeTimeModo1(u32)
```

`EVT_STATUS` (mismo bloque + distancias al principio):
```
0  distL(u16) 2 distR(u16) 4 Lrelay(u8) 5 Rrelay(u8) 6 enL(u8) 7 enR(u8)
8  sourceMode(u8) 9 mode(u8) 10 thresholdCm(u16) 12 hysteresisCm(u16)
14 retardoEntradaDist(u16) 16 retardoSalidaDist(u16) 18 retardoEntradaTemp(u16)
20 activeTimeModo1(u32)
```

## Dos números de versión distintos

Fácil de confundir — **no son lo mismo**:

- **`PROTOCOL_VERSION`** (byte que manda `EVT_BOOT`, hoy `4`): versión del
  *framing binario en sí* (offsets, tamaños). No ha cambiado desde v4; la
  app lo usa en `adaptToProtocolVersion()` para decidir compatibilidad de
  bajo nivel (heartbeat, etc.).
- **`vN` en los comentarios del código** (`v8`, `v11`, `v13`... hasta `v19`
  en la app, correcciones "v5" a "v11" en el `.ino`): numeración informal de
  **hitos de funcionalidad**, no del protocolo. Cada "vN" añadió un opcode
  nuevo o un campo nuevo *sin romper compatibilidad* — un firmware `v8` que
  recibe un comando `v11` simplemente no lo reconoce (`RES_BAD_LEN` o
  ninguna respuesta), no hay negociación de versión real más allá del byte
  de `EVT_BOOT`.

## Extensiones retrocompatibles

El patrón usado varias veces (bits de calibración en `EVT_HIGH_PRESSURE`,
`tiltOffsetMm` en la extensión de nivel, lado opcional en
`CMD_RESET_RELAYSTAT`): **añadir bytes al final** de un payload existente, y
que el lado que lee compruebe la longitud antes de leerlos. Un firmware
antiguo que no manda esos bytes de más sigue funcionando (el campo nuevo se
queda con su valor por defecto); un firmware nuevo hablando con una app
antigua tampoco rompe nada (la app simplemente ignora los bytes que no
conoce). **No** reordenar ni insertar bytes en medio de un payload existente
— eso sí rompe a cualquiera que no se actualice a la vez.
