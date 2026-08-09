import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule, AsyncPipe, DecimalPipe } from '@angular/common';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { combineLatest, BehaviorSubject, Observable, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';

import {
  IonToggle,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonBackButton,
  IonChip,
  IonLabel,
  IonButton,
  IonIcon,
} from '@ionic/angular/standalone';

import { addIcons } from 'ionicons';
import {
  settingsOutline,
  bluetoothOutline,
  powerOutline,
  waterOutline,
  speedometerOutline,
  syncOutline,
  refreshOutline,
  volumeHighOutline,
  volumeMuteOutline,
  warningOutline,
  checkmarkCircleOutline,
  lockClosedOutline,
  analyticsOutline,
} from 'ionicons/icons';

import { BluetoothService } from '../services/bluetooth.service';

const PREF_DEPOSITO_CAP = 'cfg.depositoCap';
const DEFAULT_DEPOSITO_CAP = 2000;

export type HighPressureState = 'unknown' | 'ok' | 'lockout' | 'sensor-fault';

@Component({
  selector: 'app-distance-view',
  templateUrl: './distance-view.page.html',
  styleUrls: ['./distance-view.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    AsyncPipe,
    DecimalPipe,
    IonToggle,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButtons,
    IonBackButton,
    IonChip,
    IonLabel,
    IonButton,
    IonIcon,
  ],
})
export class DistanceViewPage implements OnInit, OnDestroy {
  // Comunicación y control
  isConnected$ = this.bt.isConnected$;
  mode$ = this.bt.mode$;
  sourceMode$ = this.bt.sourceMode$;

  distanceLeft$ = this.bt.distanceLeft$;
  distanceRight$ = this.bt.distanceRight$;
  relayLeft$ = this.bt.relayLeft$;
  relayRight$ = this.bt.relayRight$;
  enabledLeft$ = this.bt.enabledLeft$;
  enabledRight$ = this.bt.enabledRight$;

  relayStats$ = combineLatest([
    this.bt.relayLeftTimeMs$,
    this.bt.relayLeftActivations$,
    this.bt.relayRightTimeMs$,
    this.bt.relayRightActivations$,
  ]).pipe(
    map(([leftMs, leftAct, rightMs, rightAct]) => ({
      L: { timeMs: leftMs, activations: leftAct },
      R: { timeMs: rightMs, activations: rightAct },
    }))
  );

  // Nivel real del depósito (sensor de baja presión + MPU6050)
  levelPercent$ = this.bt.levelPercent$;
  levelMm$ = this.bt.levelMm$;
  levelPressurePsi$ = this.bt.levelPressurePsi$;
  tiltDeg$ = this.bt.tiltDeg$;
  levelValid$ = this.bt.levelValid$;

  private depositoCap$ = new BehaviorSubject<number>(DEFAULT_DEPOSITO_CAP);

  depositoRestante$ = combineLatest([
    this.levelPercent$,
    this.depositoCap$,
  ]).pipe(
    map(([percent, capacity]) => {
      if (percent === null || percent === undefined) return null;
      const safePercent = Math.max(0, Math.min(100, Number(percent)));
      return (capacity * safePercent) / 100;
    })
  );

  depositoConsumido$ = combineLatest([
    this.depositoRestante$,
    this.depositoCap$,
  ]).pipe(
    map(([remaining, capacity]) =>
      remaining === null ? null : Math.max(0, capacity - remaining)
    )
  );

  depositoLow$ = this.levelPercent$.pipe(
    map(percent => percent !== null && percent !== undefined && percent < 10)
  );

  // Alta presión real del firmware v8
  highPressureBar$ = this.bt.highPressureBar$;
  highPressureSensorFault$ = this.bt.highPressureSensorFault$;
  highPressureLockout$ = this.bt.highPressureLockout$;
  highPressureAlarmBar$ = this.bt.highPressureAlarmBar$;
  highPressureResetBar$ = this.bt.highPressureResetBar$;
  highPressureHardLimitBar$ = this.bt.highPressureHardLimitBar$;

  highPressureState$: Observable<HighPressureState> = combineLatest([
    this.highPressureBar$,
    this.highPressureSensorFault$,
    this.highPressureLockout$,
  ]).pipe(
    map(([bar, sensorFault, lockout]) => {
      if (sensorFault) return 'sensor-fault';
      if (lockout) return 'lockout';
      if (bar === null || bar === undefined) return 'unknown';
      return 'ok';
    })
  );

  /**
   * Escala visual del manómetro:
   *   0–10 bar  -> rojo
   *   10–30 bar -> verde
   *   30–40 bar -> rojo
   *
   * Los estados de fallo y bloqueo siguen teniendo prioridad.
   */
  pressureGaugeColor$ = combineLatest([
    this.highPressureBar$,
    this.highPressureState$,
  ]).pipe(
    map(([bar, state]) => {
      if (state === 'sensor-fault') return '#8e1b1b';
      if (state === 'lockout') return '#e74c3c';
      if (state === 'unknown' || bar === null || bar === undefined) {
        return '#95a5a6';
      }

      const value = Number(bar);
      return value < 10 || value > 30
        ? '#ff4f4f'
        : '#4bd85b';
    })
  );

  pressureGaugeDash$ = this.highPressureBar$.pipe(
    map(bar => {
      const value = Math.min(Math.max(Number(bar ?? 0), 0), 40);

      // El arco visible mide aproximadamente 170 unidades.
      const fill = Math.round((value / 40) * 170);

      return `${fill} ${226 - fill}`;
    })
  );

  muted = false;

  private audioCtx: AudioContext | null = null;
  private soundInterval: ReturnType<typeof setInterval> | null = null;
  private pressureSub: Subscription | null = null;
  private lastPressureState: HighPressureState = 'unknown';

  private togglingLeft = false;
  private togglingRight = false;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private router: Router,
    public bt: BluetoothService,
  ) {
    addIcons({
      'settings-outline': settingsOutline,
      'bluetooth-outline': bluetoothOutline,
      'power-outline': powerOutline,
      'water-outline': waterOutline,
      'speedometer-outline': speedometerOutline,
      'sync-outline': syncOutline,
      'refresh-outline': refreshOutline,
      'volume-high-outline': volumeHighOutline,
      'volume-mute-outline': volumeMuteOutline,
      'warning-outline': warningOutline,
      'checkmark-circle-outline': checkmarkCircleOutline,
      'lock-closed-outline': lockClosedOutline,
      'analytics-outline': analyticsOutline,
    });
  }

  async ngOnInit(): Promise<void> {
    await this.loadLocalConfig();
    this.subscribePressureAlarm();
  }

  async ionViewWillEnter(): Promise<void> {
    await this.loadLocalConfig();

    if (this.bt.isConnected$.value) {
      await Promise.all([
        this.bt.requestStatus().catch(error => {
          console.error('requestStatus:', error);
        }),
        this.bt.requestRelayStats().catch(error => {
          console.error('requestRelayStats:', error);
        }),
        this.bt.ping().catch(error => {
          console.error('ping:', error);
        }),
      ]);

      this.startStatsPolling();
    }
  }

  ionViewWillLeave(): void {
    this.stopStatsPolling();
    this.stopAlarm();
  }

  ngOnDestroy(): void {
    this.stopStatsPolling();
    this.stopAlarm();
    this.pressureSub?.unsubscribe();
    this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
  }

  private async loadLocalConfig(): Promise<void> {
    try {
      const capacity = await Preferences.get({ key: PREF_DEPOSITO_CAP });
      const parsed = Number.parseInt(capacity.value ?? '', 10);
      this.depositoCap$.next(
        Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEPOSITO_CAP
      );
    } catch (error) {
      console.warn('No se pudo cargar la capacidad del depósito:', error);
      this.depositoCap$.next(DEFAULT_DEPOSITO_CAP);
    }
  }

  private subscribePressureAlarm(): void {
    this.pressureSub = this.highPressureState$.subscribe(state => {
      if (state === this.lastPressureState) return;
      this.lastPressureState = state;

      if (state === 'lockout' || state === 'sensor-fault') {
        this.startAlarm();
      } else {
        this.stopAlarm();
      }
    });
  }

  toggleMute(): void {
    this.muted = !this.muted;

    if (this.muted) {
      this.stopAlarm();
    } else if (
      this.lastPressureState === 'lockout' ||
      this.lastPressureState === 'sensor-fault'
    ) {
      this.startAlarm();
    }
  }

  private getAudioCtx(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
    }

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => undefined);
    }

    return this.audioCtx;
  }

  private playPressureAlarm(): void {
    try {
      const ctx = this.getAudioCtx();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.linearRampToValueAtTime(1100, now + 0.35);
      osc.frequency.linearRampToValueAtTime(520, now + 0.7);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.45, now + 0.03);
      gain.gain.setValueAtTime(0.45, now + 0.65);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.75);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.75);
    } catch (error) {
      console.warn('Error reproduciendo la alarma:', error);
    }
  }

  private startAlarm(): void {
    if (this.muted) return;
    this.stopAlarm();
    this.playPressureAlarm();
    this.soundInterval = setInterval(() => this.playPressureAlarm(), 1200);
  }

  private stopAlarm(): void {
    if (this.soundInterval) {
      clearInterval(this.soundInterval);
      this.soundInterval = null;
    }
  }

  private startStatsPolling(): void {
    this.stopStatsPolling();
    this.statsInterval = setInterval(() => {
      if (!this.bt.isConnected$.value) return;
      this.bt.requestRelayStats().catch(() => undefined);
      this.bt.requestStatus().catch(() => undefined);
    }, 2000);
  }

  private stopStatsPolling(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  goToBluetoothSettings(): void {
    this.router.navigate(['/bt-settings']);
  }

  openConfigPage(): void {
    this.router.navigate(['/auto-config']);
  }

  exitApp(): void {
    App.exitApp();
  }

  async refreshStatus(): Promise<void> {
    if (!this.bt.isConnected$.value) return;

    await Promise.all([
      this.bt.requestStatus().catch(error => {
        console.error('requestStatus:', error);
      }),
      this.bt.requestRelayStats().catch(error => {
        console.error('requestRelayStats:', error);
      }),
    ]);
  }

  async onToggleLeft(event: any): Promise<void> {
    if (this.togglingLeft) return;
    this.togglingLeft = true;
    const enabled = Boolean(event.detail.checked);

    try {
      await this.bt.setSideEnabled('L', enabled);
      if (!enabled) this.bt.relayLeft$.next(false);
    } catch (error) {
      console.error('No se pudo cambiar el lado izquierdo:', error);
      const reverted = !enabled;
      this.bt.enabledLeft$.next(reverted);
      // ion-toggle no siempre re-sincroniza su posición visual solo con el
      // binding [checked] tras haber sido tocado por el usuario (el elemento
      // nativo se queda con el valor del gesto). Se fuerza el DOM aquí para
      // que el interruptor no mienta sobre el estado real.
      if (event?.target) event.target.checked = reverted;
    } finally {
      this.togglingLeft = false;
    }
  }

  async onToggleRight(event: any): Promise<void> {
    if (this.togglingRight) return;
    this.togglingRight = true;
    const enabled = Boolean(event.detail.checked);

    try {
      await this.bt.setSideEnabled('R', enabled);
      if (!enabled) this.bt.relayRight$.next(false);
    } catch (error) {
      console.error('No se pudo cambiar el lado derecho:', error);
      const reverted = !enabled;
      this.bt.enabledRight$.next(reverted);
      if (event?.target) event.target.checked = reverted;
    } finally {
      this.togglingRight = false;
    }
  }

  formatMsToMinSec(ms: number | null | undefined): string {
    const totalSec = Math.floor(Math.max(0, Number(ms ?? 0)) / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  highPressureStateText(state: HighPressureState): string {
    switch (state) {
      case 'sensor-fault':
        return 'Fallo del sensor';
      case 'lockout':
        return 'Bloqueo por sobrepresión';
      case 'ok':
        return 'Presión normal';
      default:
        return 'Sin lectura';
    }
  }

  sourceModeText(sourceMode: number | null): string {
    return sourceMode === 1 ? 'Entradas PC817' : 'Ultrasonidos';
  }

  sideValueText(
    sourceMode: number | null,
    distance: number | null,
    outputActive: boolean | null,
  ): string {
    if (sourceMode === 1) {
      return outputActive ? 'ACTIVO' : 'INACTIVO';
    }

    return distance === null || distance === undefined
      ? '--'
      : `${distance} cm`;
  }

  levelColor(percent: number | null | undefined, valid: boolean | null): string {
    if (!valid || percent === null || percent === undefined) return '#95a5a6';
    if (percent < 10) return '#e74c3c';
    if (percent < 25) return '#f39c12';
    return '#0984e3';
  }

  levelGaugeDash(percent: number | null | undefined): string {
    const safe = Math.max(0, Math.min(100, Number(percent ?? 0)));
    const fill = Math.round((safe / 100) * 273);
    return `${fill} ${364 - fill}`;
  }
}