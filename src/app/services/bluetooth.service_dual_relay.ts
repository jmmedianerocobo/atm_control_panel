import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, Subscription, timer } from 'rxjs';

declare var bluetoothSerial: any;

// ==========================================
// INTERFACES Y TIPOS
// ==========================================

export interface BluetoothDevice {
    id: string;
    name: string;
    address: string;
}

export interface DistanceTracking {
    distanceLeft: number | null;
    formattedTimeLeft: string;
    detectionCountLeft: number;
    distanceRight: number | null;
    formattedTimeRight: string;
    detectionCountRight: number;
    relayLeftActive: boolean;
    relayRightActive: boolean;
    configurableThreshold: number;
}

export enum BluetoothErrorType {
    CONNECTION_FAILED = 'CONNECTION_FAILED',
    DISCONNECTED = 'DISCONNECTED',
    SEND_FAILED = 'SEND_FAILED',
    INVALID_DATA = 'INVALID_DATA',
    PLUGIN_NOT_AVAILABLE = 'PLUGIN_NOT_AVAILABLE',
    TIMEOUT = 'TIMEOUT'
}

export interface BluetoothError {
    type: BluetoothErrorType;
    message: string;
    originalError?: any;
    timestamp: Date;
}

export interface ConnectionStats {
    dataReceivedCount: number;
    lastDataReceivedTime: Date | null;
    reconnectAttempts: number;
    uptime: number;
}

// ==========================================
// SERVICIO PRINCIPAL
// ==========================================

@Injectable({
    providedIn: 'root'
})
export class BluetoothService implements OnDestroy {

    // --- CONSTANTES DE CONFIGURACIÓN ---
    private readonly DATA_TIMEOUT_MS = 10000;
    private readonly CONNECTION_TIMEOUT_MS = 15000;
    private readonly COMMAND_TIMEOUT_MS = 5000;
    private readonly MAX_RECONNECT_ATTEMPTS = 3;
    private readonly RECONNECT_DELAY_BASE_MS = 2000;
    private readonly MIN_THRESHOLD = 0;
    private readonly MAX_THRESHOLD = 400;

    // --- ESTADO INTERNO ---
    private receiveBuffer = '';
    private isConnected = false;
    private isConnecting = false;
    private reconnectAttempts = 0;
    private totalTimeLeftSeconds = 0;
    private totalTimeRightSeconds = 0;
    private dataReceivedCount = 0;
    private lastDataReceivedTime: Date | null = null;
    private connectionStartTime: Date | null = null;

    // --- OBSERVABLES ---
    public readonly isConnected$ = new BehaviorSubject<boolean>(false);
    public readonly connectedDevice$ = new BehaviorSubject<BluetoothDevice | null>(null);
    public readonly pairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);
    public readonly unpairedDevices$ = new BehaviorSubject<BluetoothDevice[]>([]);
    public readonly isScanning$ = new BehaviorSubject<boolean>(false);
    public readonly isSimulationEnabled$ = new BehaviorSubject<boolean>(true);
    public readonly configurableThreshold$ = new BehaviorSubject<number>(10);
    public readonly receivedData$ = new Subject<string>();
    public readonly errors$ = new Subject<BluetoothError>();
    public readonly trackingState$ = new BehaviorSubject<DistanceTracking>(this.getInitialTrackingState());

    // --- SUBSCRIPCIONES INTERNAS ---
    private simulationInterval: Subscription | null = null;
    private simulationDataFlowInterval: Subscription | null = null;
    private timeLapseInterval: Subscription | null = null;
    private connectionWatchdog: Subscription | null = null;
    private reconnectSubscription: Subscription | null = null;

    constructor() {
        console.log('[BT Service] Inicializando...');
        this.startTimeLapseTracking();
        this.startConnectionWatchdog();
        if (this.isSimulationEnabled$.value) this.startSimulation();
    }

    // ==========================================
    // CONEXIÓN
    // ==========================================

    async connect(device: BluetoothDevice): Promise<void> {
        if (this.isConnecting) throw new Error('Conexión ya en progreso');
        this.isConnecting = true;

        try {
            if (this.isSimulationEnabled$.value) {
                console.log(`[SIM] Conectando a ${device.name}`);
                await this.delay(1000);
                this.setConnected(device);
                this.startSimulationDataFlow();
                return;
            }

            if (typeof bluetoothSerial === 'undefined') {
                const error: BluetoothError = { type: BluetoothErrorType.PLUGIN_NOT_AVAILABLE, message: 'Plugin Bluetooth no disponible.', timestamp: new Date() };
                this.errors$.next(error);
                throw new Error(error.message);
            }

            await this.disconnect();

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    const error: BluetoothError = { type: BluetoothErrorType.TIMEOUT, message: 'Timeout conectando.', timestamp: new Date() };
                    this.errors$.next(error);
                    reject(new Error(error.message));
                }, this.CONNECTION_TIMEOUT_MS);

                bluetoothSerial.connect(
                    device.address,
                    () => {
                        clearTimeout(timeout);
                        this.setConnected(device);
                        this.startReceivingData();
                        resolve();
                    },
                    (err: any) => {
                        clearTimeout(timeout);
                        const error: BluetoothError = { type: BluetoothErrorType.CONNECTION_FAILED, message: `Error conectando a ${device.name}: ${err}`, originalError: err, timestamp: new Date() };
                        this.errors$.next(error);
                        reject(new Error(error.message));
                    }
                );
            });
        } finally {
            this.isConnecting = false;
        }
    }

    private setConnected(device: BluetoothDevice) {
        this.isConnected = true;
        this.isConnected$.next(true);
        this.connectedDevice$.next(device);
        this.connectionStartTime = new Date();
        this.reconnectAttempts = 0;
        this.lastDataReceivedTime = new Date();
    }

    async disconnect(): Promise<void> {
        this.stopReconnection();
        this.isConnected = false;
        this.isConnected$.next(false);
        const device = this.connectedDevice$.value;
        this.connectedDevice$.next(null);
        this.connectionStartTime = null;

        this.stopSimulation();
        this.stopSimulationDataFlow();
        this.totalTimeLeftSeconds = 0;
        this.totalTimeRightSeconds = 0;
        this.resetTrackingState();
        this.receiveBuffer = '';

        if (!this.isSimulationEnabled$.value && typeof bluetoothSerial !== 'undefined' && device) {
            try {
                bluetoothSerial.unsubscribe();
                await new Promise<void>(resolve => {
                    const timeout = setTimeout(resolve, 3000);
                    bluetoothSerial.disconnect(() => {
                        clearTimeout(timeout);
                        resolve();
                    }, () => { clearTimeout(timeout); resolve(); });
                });
            } catch (e) { console.warn('[BT] Error al desconectar:', e); }
        }
    }

    // ==========================================
    // RECONEXIÓN
    // ==========================================

    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            this.errors$.next({ type: BluetoothErrorType.DISCONNECTED, message: 'Máximo de reintentos alcanzado.', timestamp: new Date() });
            return;
        }

        const device = this.connectedDevice$.value;
        if (!device) return;

        this.reconnectAttempts++;
        const delayTime = this.RECONNECT_DELAY_BASE_MS * this.reconnectAttempts;
        console.log(`[BT] Reconexión ${this.reconnectAttempts} en ${delayTime}ms`);

        this.reconnectSubscription = timer(delayTime).subscribe(() => {
            this.connect(device).catch(err => {
                console.error('[BT] Error reconectando:', err);
                if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) this.attemptReconnect();
            });
        });
    }

    private stopReconnection() {
        this.reconnectSubscription?.unsubscribe();
        this.reconnectSubscription = null;
        this.reconnectAttempts = 0;
    }

    // ==========================================
    // WATCHDOG
    // ==========================================

    private startConnectionWatchdog() {
        this.connectionWatchdog = timer(0, 5000).subscribe(() => {
            if (this.isConnected$.value && !this.isSimulationEnabled$.value && this.lastDataReceivedTime) {
                const elapsed = Date.now() - this.lastDataReceivedTime.getTime();
                if (elapsed > this.DATA_TIMEOUT_MS) {
                    console.warn('[BT] Desconexión detectada por timeout de datos');
                    this.handleUnexpectedDisconnection();
                }
            }
        });
    }

    private handleUnexpectedDisconnection() {
        this.isConnected = false;
        this.isConnected$.next(false);
        this.errors$.next({ type: BluetoothErrorType.DISCONNECTED, message: 'Conexión perdida inesperadamente', timestamp: new Date() });
        this.attemptReconnect();
    }

    // ==========================================
    // ENVÍO DE COMANDOS
    // ==========================================

    async sendCommand(command: string): Promise<void> {
        if (!this.isConnected$.value) {
            const errMsg = `No conectado. Comando '${command}' fallido.`;
            this.errors$.next({ type: BluetoothErrorType.SEND_FAILED, message: errMsg, timestamp: new Date() });
            throw new Error(errMsg);
        }

        if (this.isSimulationEnabled$.value) {
            await this.delay(50);
            this.simulateCommandResponse(command);
            return;
        }

        if (typeof bluetoothSerial !== 'undefined') {
            const fullCommand = command.endsWith('\n') ? command : command + '\n';
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    const error: BluetoothError = { type: BluetoothErrorType.TIMEOUT, message: `Timeout enviando: ${command}`, timestamp: new Date() };
                    this.errors$.next(error);
                    reject(new Error(error.message));
                }, this.COMMAND_TIMEOUT_MS);

                bluetoothSerial.write(fullCommand, () => {
                    clearTimeout(timeout);
                    resolve();
                }, err => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
        }
    }

    // ==========================================
    // RECEPCIÓN DE DATOS
    // ==========================================

    private startReceivingData() {
        if (typeof bluetoothSerial === 'undefined' || this.isSimulationEnabled$.value) return;

        try { bluetoothSerial.unsubscribe(); } catch {}

        bluetoothSerial.subscribe('\n', (data: string) => {
            this.lastDataReceivedTime = new Date();
            this.handleIncomingData(data);
        }, err => {
            console.error('[BT] Error en recepción:', err);
            this.handleUnexpectedDisconnection();
        });
    }

    handleIncomingData(data: string) {
        this.receiveBuffer += data;
        let newlineIndex: number;
        while ((newlineIndex = this.receiveBuffer.indexOf('\n')) !== -1) {
            const msg = this.receiveBuffer.substring(0, newlineIndex).trim();
            this.receiveBuffer = this.receiveBuffer.substring(newlineIndex + 1);
            if (msg.length > 0) {
                this.dataReceivedCount++;
                this.receivedData$.next(msg);
                this.decodeArduinoMessage(msg);
            }
        }
        if (this.receiveBuffer.length > 1000) this.receiveBuffer = '';
    }

    decodeArduinoMessage(message: string) {
        try {
            if (message.startsWith("HEARTBEAT")) return;
            if (message.startsWith("D:")) this.processTrackingData(message);
            else if (message.startsWith("DIST:")) this.processDistanceData(message);
            else if (message.startsWith("ACK")) console.log('[BT] ACK recibido:', message);
            else if (message.startsWith("READY")) console.log('[BT] Arduino listo');
            else if (message.startsWith("RELAYS:")) this.processRelayStatus(message);
            else if (message.startsWith("ERROR")) this.errors$.next({ type: BluetoothErrorType.INVALID_DATA, message: message, timestamp: new Date() });
            else console.log('[BT] Mensaje:', message);
        } catch (err) {
            this.errors$.next({ type: BluetoothErrorType.INVALID_DATA, message: 'Error procesando mensaje', originalError: err, timestamp: new Date() });
        }
    }

    private processTrackingData(message: string) {
        const parts = message.substring(2).split(':');
        const stats: any = {};
        parts.forEach(pair => {
            const [k, v] = pair.split('=');
            if (k && v) stats[k.toLowerCase()] = k==='RL'||k==='RR' ? v==='1' : parseInt(v,10);
        });
        this.trackingState$.next({ ...this.trackingState$.value,
            distanceLeft: stats['l'] ?? this.trackingState$.value.distanceLeft,
            distanceRight: stats['r'] ?? this.trackingState$.value.distanceRight,
            relayLeftActive: stats['rl'] ?? this.trackingState$.value.relayLeftActive,
            relayRightActive: stats['rr'] ?? this.trackingState$.value.relayRightActive,
            detectionCountLeft: stats['cl'] ?? this.trackingState$.value.detectionCountLeft,
            detectionCountRight: stats['cr'] ?? this.trackingState$.value.detectionCountRight,
            configurableThreshold: stats['t'] ?? this.trackingState$.value.configurableThreshold,
        });
    }

    private processDistanceData(message: string) {
        const parts = message.substring(5).split(',');
        const dist: any = {};
        parts.forEach(pair => {
            const [k,v] = pair.split('='); if(k && v) dist[k.toLowerCase()] = parseInt(v,10);
        });
        this.trackingState$.next({...this.trackingState$.value, 
            distanceLeft: dist['l'] ?? this.trackingState$.value.distanceLeft,
            distanceRight: dist['r'] ?? this.trackingState$.value.distanceRight,
        });
    }

    private processRelayStatus(message: string) {
        const parts = message.substring(7).split(':');
        const newState = {...this.trackingState$.value};
        parts.forEach(pair => {
            const [k,v] = pair.split('='); if(k==='L') newState.relayLeftActive=v==='ON'; if(k==='R') newState.relayRightActive=v==='ON';
        });
        this.trackingState$.next(newState);
    }

    // ==========================================
    // SIMULACIÓN
    // ==========================================

    enableSimulation(enable: boolean) {
        this.isSimulationEnabled$.next(enable);
        if(enable) this.startSimulation();
        else this.stopSimulation();
    }

    private startSimulation() {
        if(this.simulationInterval) return;
        this.setConnected({id:'SIM', name:'HC-06 SIMULADO', address:'00:00:00:00:00:00'});
        this.simulationInterval = timer(0,500).subscribe(() => {
            const t = this.trackingState$.value;
            const threshold = this.configurableThreshold$.value;
            let l = Math.round(Math.random()*20+5), r = Math.round(Math.random()*20+5);
            if(t.relayLeftActive && l>threshold) l=Math.round(Math.random()*threshold*0.5);
            if(t.relayRightActive && r>threshold) r=Math.round(Math.random()*threshold*0.5);
            let cl = t.detectionCountLeft, cr = t.detectionCountRight;
            if(l<threshold && !t.relayLeftActive) cl++;
            if(r<threshold && !t.relayRightActive) cr++;
            this.trackingState$.next({...t,distanceLeft:l,distanceRight:r,detectionCountLeft:cl,detectionCountRight:cr});
        });
    }

    private stopSimulation() {
        this.simulationInterval?.unsubscribe(); this.simulationInterval=null;
    }

    private startSimulationDataFlow() {
        this.stopSimulationDataFlow();
        this.simulationDataFlowInterval = timer(0,1000).subscribe(()=>{
            const t=this.trackingState$.value;
            const msg=`DIST:L=${t.distanceLeft??0},R=${t.distanceRight??0}`;
            this.receivedData$.next(msg);
            this.dataReceivedCount++;
        });
    }

    private stopSimulationDataFlow() {
        this.simulationDataFlowInterval?.unsubscribe();
        this.simulationDataFlowInterval=null;
    }

    private simulateCommandResponse(cmd: string) {
        const t=this.trackingState$.value;
        const newState={...t};
        if(cmd==="RELAY_L:ON") newState.relayLeftActive=true;
        if(cmd==="RELAY_L:OFF") newState.relayLeftActive=false;
        if(cmd==="RELAY_R:ON") newState.relayRightActive=true;
        if(cmd==="RELAY_R:OFF") newState.relayRightActive=false;
        if(cmd==="RESET:COUNTERS"){newState.detectionCountLeft=0; newState.detectionCountRight=0; this.totalTimeLeftSeconds=0; this.totalTimeRightSeconds=0;}
        if(cmd.startsWith("THRESHOLD:")){const val=parseInt(cmd.split(':')[1],10); if(!isNaN(val)){newState.configurableThreshold=val; this.configurableThreshold$.next(val);}}
        this.trackingState$.next(newState);
    }

    // ==========================================
    // TRACKING DE TIEMPO
    // ==========================================

    private startTimeLapseTracking(){
        if(this.timeLapseInterval) return;
        this.timeLapseInterval = timer(0,1000).subscribe(()=>{
            const t=this.trackingState$.value;
            if(t.relayLeftActive) this.totalTimeLeftSeconds++;
            if(t.relayRightActive) this.totalTimeRightSeconds++;
            this.trackingState$.next({...t, formattedTimeLeft:this.formatSecondsToTime(this.totalTimeLeftSeconds), formattedTimeRight:this.formatSecondsToTime(this.totalTimeRightSeconds)});
        });
    }

    private formatSecondsToTime(sec:number):string{
        const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
        return [h,m,s].map(v=>v<10?'0'+v:v).join(':');
    }

    // ==========================================
    // UTILIDADES
    // ==========================================

    private getInitialTrackingState(): DistanceTracking{
        return {distanceLeft:null,formattedTimeLeft:'00:00:00',detectionCountLeft:0,distanceRight:null,formattedTimeRight:'00:00:00',detectionCountRight:0,relayLeftActive:false,relayRightActive:false,configurableThreshold:10};
    }

    private resetTrackingState(){
        this.trackingState$.next(this.getInitialTrackingState());
    }

    getStats(): ConnectionStats{
        return {dataReceivedCount:this.dataReceivedCount,lastDataReceivedTime:this.lastDataReceivedTime,reconnectAttempts:this.reconnectAttempts,uptime:this.connectionStartTime?Math.floor((Date.now()-this.connectionStartTime.getTime())/1000):0};
    }

    private delay(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms));}

    ngOnDestroy(): void {this.cleanup();}

    public cleanup(){
        this.simulationInterval?.unsubscribe();
        this.simulationDataFlowInterval?.unsubscribe();
        this.timeLapseInterval?.unsubscribe();
        this.connectionWatchdog?.unsubscribe();
        this.reconnectSubscription?.unsubscribe();
        this.disconnect();
    }
}
