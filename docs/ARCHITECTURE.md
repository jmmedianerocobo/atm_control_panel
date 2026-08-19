# Arquitectura de `atm-control-panel`

Este documento explica **por qué** está montado así, no solo qué hay —
para eso ya está el código. Si vas a tocar algo, lee primero la sección
correspondiente; varios de estos puntos son la solución a un bug real que
ya se dio una vez.

## Vista general

```
┌─────────────────────────────────────────────────────────────┐
│  Páginas (Angular standalone components)                     │
│  distance-view (dashboard) · bt-settings · auto-config        │
│  — consumen BluetoothService, nunca el transporte directamente│
└───────────────────────────┬────────────────────────────────┘
                             │  this.bt.xxx$ / this.bt.metodo()
┌───────────────────────────▼────────────────────────────────┐
│  BluetoothService  (fachada de DOMINIO)                       │
│  decodifica EVT_* del atomizador, expone estado público,      │
│  calibraciones, persistencia de config LOCAL (Preferences)    │
└───────────────────────────┬────────────────────────────────┘
                             │  transport.sendCmd() / transport.frame$
┌───────────────────────────▼────────────────────────────────┐
│  BleTransportService  (transporte, "tonto" a propósito)       │
│  framing/CRC, cola de comandos con prioridad, parser RX,      │
│  conexión/heartbeat/reconexión de bajo nivel, emparejamiento  │
└───────────────────────────┬────────────────────────────────┘
                             │  bluetoothSerial (cordova-plugin, SPP)
                    ══════════════════════
                    Bluetooth Classic (SPP)
                    ══════════════════════
                             │
                    Arduino (atm-firmware) — ver PROTOCOL.md
```

## Por qué dos servicios y no uno

Hasta hace poco todo esto era un único `BluetoothService` de 900+ líneas.
Se partió (sin cambiar comportamiento — verificado exhaustivamente con
tests antes/después y en el dispositivo real) porque mezclaba dos
responsabilidades con ciclos de vida distintos:

- **Transporte** (`BleTransportService`): sabe hablar el protocolo binario
  y mantener el enlace vivo. No sabe qué significa un `EVT_LEVEL`, ni le
  importa. Reutilizable tal cual si mañana hay que hablar con otro tipo de
  equipo que use el mismo framing.
- **Fachada de dominio** (`BluetoothService`): sabe qué es un atomizador —
  decodifica los `EVT_*` a estado con sentido (nivel, presión, salidas),
  valida configuración, calibra, persiste localmente. No sabe nada de CRC
  ni de reintentos.

La comunicación entre ambos es deliberadamente estrecha: el transporte
expone `frame$` (un `Subject<RawFrame>` con lo que no gestiona
internamente — todo menos ACK/`EVT_BOOT`/`EVT_KEEPALIVE`) y
`reconnectRequested$` (avisa "el heartbeat cree que esto está muerto", pero
la reconexión de *verdad* vive en la fachada porque implica rehacer la
sincronización de dominio de `connect()`, no solo reabrir el socket).

## Cola de comandos con prioridad

Todos los comandos pasan por `BleTransportService.sendCmd()`, que los mete
en una única cola con dos prioridades:

- **`'high'`**: acciones del usuario (aplicar config, calibrar, probar,
  parada de emergencia). Se cuelan delante de cualquier `'low'` que siga en
  cola sin haberse despachado aún.
- **`'low'`**: tráfico de fondo (`requestStatus`, `requestRelayStats`,
  `ping`). Nunca deben bloquear una acción explícita del usuario.

Un único *worker* (`runCmdWorker()`) despacha la cola en serie — el
Arduino es de un solo hilo y no tiene sentido mandarle dos comandos a la
vez. Dedupe: si ya hay un comando del mismo tipo **todavía en cola** (no
en curso), el nuevo lo reemplaza en vez de apilarse — pero un comando que
ya se está escribiendo por el puerto serie no se puede "cancelar", así que
el dedupe solo aplica al que sigue esperando turno.

## Patrón "promesa fantasma": por qué casi todo tiene timeout propio

Este ha sido el bug de fondo más repetido del proyecto, en tres sitios
distintos, y merece nombre propio: **un callback de un plugin nativo
(Cordova/Capacitor) que a veces simplemente no llega — ni éxito ni error—
dejando una promesa colgada para siempre.**

Apareció en:
1. `bluetoothSerial.write()` (`writeBytes()` en el transporte).
2. `bluetoothSerial.connect()` (`connect()` en el transporte).
3. `navigator.clipboard.writeText()` (`copyDiagnostics()` en `bt-settings`).

La solución es siempre la misma forma: envolver la llamada en una
`Promise` con un `setTimeout` propio y una bandera `settled` que ignora
con seguridad un callback nativo tardío que llegue después de que el
timeout ya haya resuelto la promesa por su cuenta. **Si añades una llamada
nueva a un plugin nativo, asume que puede no volver nunca y dale timeout
propio** — no confíes en que "total, ya tiene el timeout del que lo llama
por encima", porque casi siempre esa promesa exterior está `await`-ando
justo la que se queda colgada.

Segunda vuelta de tuerca (encontrada escribiendo el test de esto): el
timer de ACK arranca *antes* de que `writeBytes()` termine, así que si el
propio write tarda casi tanto como el timeout del ACK, pueden competir por
quién "gana" primero — ver `sendCmdInternal()` en `ble-transport.service.ts`
y el `p.catch(() => {})` defensivo junto a él.

## Heartbeat y reconexión

Con conexión activa, el transporte manda `CMD_PING` cada pocos segundos.
Si **3 pings seguidos** fallan, emite `reconnectRequested$` — no reconecta
él mismo (ver arriba). La fachada, al recibirlo, hace `disconnect()` +
espera + `connect()` del mismo dispositivo, con un tope de reintentos
(`MAX_RECONNECT_ATTEMPTS`) para no ciclar infinito si el equipo está
apagado de verdad.

`pauseHeartbeat` (en el transporte, activado por la fachada durante
`flushConfig()`) evita que un ping de fondo compita por el puerto serie
justo cuando se está mandando una configuración — sin esto, un ping mal
sincronizado podía hacer fallar el envío de config con un error confuso.

## Quién guarda qué (y por qué hay dos sitios)

| Dato | Vive en | Por qué |
|---|---|---|
| Config operativa (modo, umbral, retardos, geometría, límites de presión) | **EEPROM del Arduino** | es lo que de verdad decide el comportamiento del equipo; debe sobrevivir a que la app se desinstale |
| La MISMA config, copia local | `Preferences` (Capacitor, → `localStorage` en Android WebView) | para que la UI arranque con el último valor conocido antes de conectar, y para reenviar la intención del usuario si tocó algo estando desconectado (ver `connect()` en la fachada) |
| `depositoCap` (litros) | **solo** `Preferences` | es un cálculo de la propia app (% → litros); el firmware no lo conoce ni le hace falta |

El protocolo **no tiene un comando de "leer configuración completa"**
(`CMD_GET_CONFIG` no existe todavía — ver el ítem pendiente en el historial
del proyecto). Por eso la app solo sabe la config real si (a) la ha
mandado ella misma con éxito, o (b) llega en un `EVT_STATUS`/`EVT_SNAPSHOT`.
Si otro cliente Bluetooth cambia algo, esta app no se entera hasta que se
implemente ese comando.

## Páginas

- **`distance-view`**: dashboard principal (ruta `/distance-view`, y
  también la raíz `''` redirige aquí). Sondeo periódico de estado cada 2s
  mientras hay conexión, alarma sonora de alta presión (Web Audio API,
  `startAlarm()`/`stopAlarm()`), indicador de silencio siempre visible.
- **`bt-settings`**: emparejar/buscar/conectar, eliminar emparejamientos
  (requiere el parche de `cordova-plugin-bluetooth-serial`, ver abajo),
  exportar diagnóstico (vuelca `logEntries$` al portapapeles con 3 niveles
  de fallback).
- **`auto-config`**: parámetros operativos, geometría del depósito,
  calibraciones (nivel 2 puntos, inclinación 2 pasos, alta presión 2
  puntos). El botón "Aplicar" solo reenvía los grupos de config
  realmente tocados (`generalDirty`/`geometryDirty`/`pressureDirty`), no
  los tres comandos siempre.
- **`home`**: ⚠️ **no se usa**. Sobra del starter por defecto de Ionic; no
  está en `app.routes.ts`. Se documenta aquí para que quede claro que es
  descuido, no que falte enlazarla a algo.

Las tres páginas reales comparten un mismo patrón para "toast": Ionic
`<ion-toast>` **no se renderiza visiblemente** en el WebView de la tablet
Samsung real de este proyecto (se activa de verdad — `isOpen`/`message`
confirmados — pero el `toast-wrapper` de su shadow DOM se queda en
`opacity:0.01`, comprobado con Chrome DevTools Protocol contra el
dispositivo). `AlertController` sí se ve bien en el mismo dispositivo, así
que se reutiliza como sustituto con auto-cierre (`presentToast()` en cada
página) — no repitas el intento con `ion-toast` en este proyecto sin
volver a probarlo primero en el dispositivo real.

## Parches (`patch-package`)

- **`cordova-plugin-bluetooth-serial+0.4.7.patch`**: añade un método
  `unpair()` nativo (Java, vía reflexión sobre `BluetoothDevice.removeBond()`,
  que es `@hide` en el SDK público de Android) — el plugin original no
  ofrece ninguna forma de desemparejar. Lo usa el botón "eliminar todos los
  emparejados" de `bt-settings`.
- **`cross-spawn+7.0.6.patch`**: fix de un bug real de `cross-spawn` en
  Windows — `path.normalize()` sobre una ruta relativa tipo `./gradlew`
  la colapsa a `gradlew` sin separador, y `cmd.exe /c` no busca comandos
  sueltos en el directorio actual, así que el build de Android fallaba con
  `'gradlew' is not recognized...` aunque `gradlew.bat` existiera al lado.
  No es un problema de este proyecto — es upstream de `cross-spawn`.

## Testing

160+ tests (Jasmine/Karma, `ChromeHeadless`) sobre `BleTransportService`,
`BluetoothService` y las tres páginas reales — corren solos en cada push
(`.github/workflows/test.yml`: `tsc --noEmit` + `ng test`).

Patrón general: dobles ligeros hechos a mano (no un mocking framework) con
la superficie exacta que cada consumidor usa — p.ej. `FakeBluetoothService`
en cada spec de página solo tiene los `BehaviorSubject`/métodos que esa
página concreta toca. Los diálogos (`AlertController`) se doblan
distinguiendo confirmaciones (llevan `header`) de toasts (no lo llevan).

**Deliberadamente sin testear**: `App.exitApp()` (`@capacitor/app`) — en
web lanza una promesa rechazada sin manejar ("Not implemented"), y el
propio código no la espera ni la captura; testearlo de verdad ensuciaría
la suite con una rejection real sin aportar nada.

### Dos "gotchas" del entorno de test, no bugs del código

1. **Los plugins de Capacitor (`registerPlugin()`) no se pueden espiar con
   `spyOn()`.** Devuelven un `Proxy` cuyo `get()` fabrica un wrapper nuevo
   en cada acceso, ignorando cualquier valor que `spyOn()` le asigne
   encima — no lanza error, simplemente no intercepta nada. Afecta a
   `Preferences` y `App`. Solución usada: para `Preferences`, tests contra
   `localStorage` real (limpiado en cada test) en vez de espiar.

2. **Ese mismo plugin web carga su implementación con un `import()`
   dinámico REAL** la primera vez que se usa — un import de módulo de
   verdad resuelto por el navegador, no un microtask. `fakeAsync()`/
   `tick()` no puede forzarlo a resolverse por mucho margen virtual que se
   le dé, porque vive fuera del reloj falso. Si la primera llamada de toda
   la suite cae dentro de un `fakeAsync()`, el test se queda con
   aserciones en 0 sin motivo aparente — pasó de verdad en CI (Linux) sin
   fallar nunca en local (Windows), justo por diferencias de timing/orden
   de ejecución. Arreglo: un `beforeAll()` con un `await` real (fuera de
   cualquier `fakeAsync`) que precalienta el import antes de que corra
   ningún test — ver `bluetooth.service.spec.ts` y
   `distance-view.page.spec.ts`.

3. Bonus, no relacionado con Capacitor: `let x: T | null = null`
   reasignada dentro de un `.subscribe()` hace que TypeScript la siga
   viendo como literal `null` fuera del closure y rechace compararla con
   valores no nulos. Se resuelve con aserción de asignación definida
   (`let x!: T | null`) en vez del inicializador.

## CI

`.github/workflows/test.yml`: en cualquier rama (push) y en PRs contra
`main` — `npm ci` → `tsc --noEmit` (app + spec) → `ng test` con
`CHROME_BIN=/usr/bin/google-chrome-stable` (preinstalado en los runners
`ubuntu-latest` de GitHub). Sin pasos de build/deploy a propósito: es el
mínimo que hace que un test roto se note solo.
