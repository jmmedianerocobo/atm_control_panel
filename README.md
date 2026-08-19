# ATM Control Panel

App Android (Ionic + Angular + Capacitor) para controlar y monitorizar un
**atomizador agrícola de doble salida** por Bluetooth Classic (SPP), con
detección por ultrasonido o entradas digitales aisladas, nivel de depósito
compensado por inclinación, y bloqueo de seguridad por alta presión.

Es la mitad "app" de un sistema de dos repos:

| Repo | Qué es | Dónde |
|---|---|---|
| `atm-control-panel` (este) | App Android que controla el equipo | https://github.com/jmmedianerocobo/atm_control_panel |
| `atm-firmware` | Firmware del Arduino que va dentro del atomizador | https://github.com/jmmedianerocobo/atm-firmware (privado) |

Los dos se comunican por un protocolo binario propio sobre Bluetooth Classic
(SPP) — ver [`docs/PROTOCOL.md`](docs/PROTOCOL.md), que es la fuente de
verdad compartida por ambos repos (opcodes, formato de trama, payloads).

## Qué hace

- Detecta objetivo por **ultrasonido** (HC-SR04, dos lados independientes) o
  por **entradas digitales aisladas PC817** (útil si el disparo ya lo decide
  otro equipo, p.ej. un sensor de fila en el tractor).
- Activa dos salidas MOSFET (izquierda/derecha) en modo continuo (mientras
  hay detección) o temporizado (pulso de duración fija).
- Mide el **nivel del depósito** con un sensor de presión, compensado por la
  inclinación real del equipo (MPU6050) — calibración en dos puntos
  (vacío/lleno) para no depender de la densidad del líquido.
- Vigila la **presión de línea/bomba** y corta ambas salidas de inmediato si
  se dispara (bloqueo de seguridad con rearme por histéresis), con alarma
  sonora en la app.
- Guarda estadísticas de uso por lado (tiempo activo, nº de activaciones).

## Puesta en marcha

```bash
npm install
npx ng test --watch=false --browsers=ChromeHeadless   # 160 tests, ver más abajo
npx ionic capacitor run android --external --livereload --target=<adb-serial>
```

`CHROME_BIN` debe apuntar a un Chrome/Chromium instalado si `ng test` no lo
encuentra solo (`export CHROME_BIN="C:/Program Files/Google/Chrome/Application/chrome.exe"`
en este entorno). `npx ionic capacitor run android --list` da el
`target` (serial adb) del dispositivo conectado.

## Estructura

```
src/app/
  services/
    ble-transport.service.ts   # protocolo binario, cola de comandos, reconexión (capa "tonta")
    bluetooth.service.ts       # fachada de dominio: decodifica EVT_*, estado de la app, calibraciones
  distance-view/    # pantalla principal — dashboard en vivo
  bt-settings/      # emparejar/conectar/diagnóstico
  auto-config/      # parámetros, geometría del depósito, calibraciones
  home/             # ⚠️ no usado — no está en las rutas activas (app.routes.ts), sobra del starter de Ionic
docs/
  ARCHITECTURE.md   # por qué está montado así, decisiones, "gotchas" conocidos
  PROTOCOL.md        # protocolo binario compartido con el firmware
patches/            # parches vía patch-package (ver docs/ARCHITECTURE.md)
```

Más detalle de por qué está dividido así, qué hay que saber antes de tocar
cada pieza, y una lista de problemas ya resueltos que no conviene reabrir
por accidente: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tests y CI

138+ tests (Jasmine/Karma) sobre los dos servicios y las tres páginas reales
de la app — no solo "compila", sino comportamiento: colas de comandos,
reconexión, validación de configuración, reversión optimista de toggles,
etc. Corren solos en cada push vía GitHub Actions
(`.github/workflows/test.yml`).

```bash
export CHROME_BIN="C:/Program Files/Google/Chrome/Application/chrome.exe"
npx ng test --watch=false --browsers=ChromeHeadless
```

## Stack

Ionic 8 · Angular 20 (standalone components) · Capacitor 7 · TypeScript ·
`cordova-plugin-bluetooth-serial` (con un parche propio, ver
[ARCHITECTURE.md](docs/ARCHITECTURE.md#parches-patch-package)) para
Bluetooth Classic — Capacitor no lo soporta nativamente, solo BLE.
