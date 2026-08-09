import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { BluetoothService } from '../services/bluetooth.service';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { combineLatest, BehaviorSubject, Observable, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';

import { CommonModule, AsyncPipe, DecimalPipe } from '@angular/common';
import {
  IonToggle, IonHeader, IonToolbar, IonTitle,
  IonContent, IonButtons, IonBackButton,
  IonChip, IonLabel, IonButton, IonIcon
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  settingsOutline, bluetoothOutline, powerOutline,
  waterOutline, water, speedometerOutline,
  syncOutline, refreshOutline,
  volumeHighOutline, volumeMediumOutline,
} from 'ionicons/icons';

// ─── Persistencia de contadores de flujo ───────────────────────────────────
const PREF_PARTIAL_BASE  = 'flow_partial_base';
const PREF_DEPOSITO_BASE = 'flow_deposito_base';
const DEPOSITO_CAPACITY  = 2000;

// ─── Umbrales de presión ────────────────────────────────────────────────────
const PRESSURE_MAX = 40;
const PRESSURE_MIN = 10;

export type PressureState = 'ok' | 'high' | 'low';

@Component({
  selector: 'app-distance-view',
  templateUrl: './distance-view.page.html',
  styleUrls: ['./distance-view.page.scss'],
  standalone: true,
  imports: [
    CommonModule, AsyncPipe, DecimalPipe,
    IonToggle, IonHeader, IonToolbar, IonTitle,
    IonContent, IonButtons, IonBackButton,
    IonChip, IonLabel, IonButton, IonIcon,
  ],
})
export class DistanceViewPage implements OnInit, OnDestroy {

  // ── Ultrasonidos ───────────────────────────────────────────────────────────
  distanceLeft$  = this.bt.distanceLeft$;
  distanceRight$ = this.bt.distanceRight$;
  relayLeft$     = this.bt.relayLeft$;
  relayRight$    = this.bt.relayRight$;
  enabledLeft$   = this.bt.enabledLeft$;
  enabledRight$  = this.bt.enabledRight$;
  isConnected$   = this.bt.isConnected$;
  mode$          = this.bt.mode$;

  // ── Estadísticas de relés ──────────────────────────────────────────────────
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

  // ── Flujo ──────────────────────────────────────────────────────────────────
  flowRateLMin$ = this.bt.flowRateLMin$;
  flowDetected$ = this.bt.flowDetected$;

  private partialBase$  = new BehaviorSubject<number>(0);
  private depositoBase$ = new BehaviorSubject<number>(0);

  private consumido$ = combineLatest([
    this.bt.totalLitres$,
    this.depositoBase$,
  ]).pipe(map(([total, base]) => Math.max(0, (total ?? 0) - base)));

  depositoRestante$ = this.consumido$.pipe(
    map(c => Math.max(0, DEPOSITO_CAPACITY - c))
  );
  depositoConsumido$ = this.consumido$;
  depositoPct$ = this.depositoRestante$.pipe(
    map(r => (r / DEPOSITO_CAPACITY) * 100)
  );
  depositoLow$ = this.depositoRestante$.pipe(
    map(r => r < DEPOSITO_CAPACITY * 0.1)
  );

  partialLitres$ = combineLatest([
    this.bt.totalLitres$,
    this.partialBase$,
  ]).pipe(map(([total, base]) => Math.max(0, (total ?? 0) - base)));

  // ── Presión ────────────────────────────────────────────────────────────────
  pressureBar$ = this.bt.pressureBar$;

  pressureState$: Observable<PressureState> = this.pressureBar$.pipe(
    map(bar => {
      if (bar === null || bar === undefined) return 'ok';
      if ((bar as number) > PRESSURE_MAX) return 'high' as PressureState;
      if ((bar as number) < PRESSURE_MIN) return 'low'  as PressureState;
      return 'ok';
    })
  );

  pressureGaugeColor$ = this.pressureState$.pipe(
    map(s => s === 'high' ? '#e74c3c' : s === 'low' ? '#f39c12' : '#27ae60')
  );

  pressureGaugeDash$ = this.pressureBar$.pipe(
    map(bar => {
      const val  = Math.min(Math.max((bar as number) ?? 0, 0), 60);
      const fill = Math.round((val / 60) * 170);
      const gap  = 226 - fill;
      return `${fill} ${gap}`;
    })
  );

  // ── Audio ──────────────────────────────────────────────────────────────────
  private audioCtx: AudioContext | null = null;
  private soundInterval: any = null;
  private lastPressureState: PressureState = 'ok';
  private pressureSub: Subscription | null = null;

  // ── Toggles — flags anti-rebote ───────────────────────────────────────────
  private togglingLeft  = false;
  private togglingRight = false;

  // ── Polling ────────────────────────────────────────────────────────────────
  private statsInterval: any = null;

  constructor(private router: Router, public bt: BluetoothService) {
    addIcons({
      'settings-outline':      settingsOutline,
      'bluetooth-outline':     bluetoothOutline,
      'power-outline':         powerOutline,
      'water-outline':         waterOutline,
      'water':                 water,
      'speedometer-outline':   speedometerOutline,
      'sync-outline':          syncOutline,
      'refresh-outline':       refreshOutline,
      'volume-high-outline':   volumeHighOutline,
      'volume-medium-outline': volumeMediumOutline,
    });
  }

  async ngOnInit() {
    await this.loadPersistedBases();
    this.subscribePressureAlarm();
  }

  ionViewWillEnter() {
    if (this.bt.isConnected$.value) {
      this.bt.requestStatus().catch(() => {});
      this.bt.requestRelayStats().catch(() => {});
      this.bt.ping().catch(() => {});
      this.startStatsPolling();
    }
  }

  ionViewWillLeave() {
    this.stopStatsPolling();
    this.stopAlarm();
  }

  ngOnDestroy() {
    this.stopStatsPolling();
    this.stopAlarm();
    this.pressureSub?.unsubscribe();
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  // ── Suscripción alarma de presión ──────────────────────────────────────────
  private subscribePressureAlarm() {
    this.pressureSub = this.pressureState$.subscribe(state => {
      if (state === this.lastPressureState) return;
      this.lastPressureState = state;
      if (state === 'high')      this.startAlarm('high');
      else if (state === 'low')  this.startAlarm('low');
      else                       this.stopAlarm();
    });
  }

  // ── Audio ──────────────────────────────────────────────────────────────────
  private getAudioCtx(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  private playAlarmHigh() {
    try {
      const ctx = this.getAudioCtx();
      const now = ctx.currentTime;
      const dur = 1.3;

      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(300,  now);
      osc.frequency.linearRampToValueAtTime(1200, now + 0.6);
      osc.frequency.linearRampToValueAtTime(300,  now + 1.2);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.55, now + 0.05);
      gain.gain.setValueAtTime(0.55, now + 1.15);
      gain.gain.linearRampToValueAtTime(0.001, now + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + dur);

      const osc2  = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sawtooth';
      osc2.frequency.setValueAtTime(304,  now);
      osc2.frequency.linearRampToValueAtTime(1208, now + 0.6);
      osc2.frequency.linearRampToValueAtTime(304,  now + 1.2);
      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.linearRampToValueAtTime(0.25, now + 0.05);
      gain2.gain.setValueAtTime(0.25, now + 1.15);
      gain2.gain.linearRampToValueAtTime(0.001, now + dur);
      osc2.connect(gain2); gain2.connect(ctx.destination);
      osc2.start(now); osc2.stop(now + dur);
    } catch (e) { console.warn('Audio error (high):', e); }
  }

  private playAlarmLow() {
    try {
      const ctx = this.getAudioCtx();
      const now = ctx.currentTime;

      const playTone = (freq: number, startAt: number, duration: number, volume: number) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        const osc2  = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'triangle';
        osc.frequency.setValueAtTime(freq, startAt);
        osc2.frequency.setValueAtTime(freq, startAt);
        gain.gain.setValueAtTime(0.001, startAt);
        gain.gain.linearRampToValueAtTime(volume, startAt + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
        gain2.gain.setValueAtTime(0.001, startAt);
        gain2.gain.linearRampToValueAtTime(volume * 0.4, startAt + 0.01);
        gain2.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
        osc.connect(gain);   gain.connect(ctx.destination);
        osc2.connect(gain2); gain2.connect(ctx.destination);
        osc.start(startAt);  osc.stop(startAt + duration);
        osc2.start(startAt); osc2.stop(startAt + duration);
      };

      playTone(523, now,        0.35, 0.45);
      playTone(392, now + 0.38, 0.45, 0.38);
    } catch (e) { console.warn('Audio error (low):', e); }
  }

  private startAlarm(type: 'high' | 'low') {
    this.stopAlarm();
    const fn       = type === 'high' ? () => this.playAlarmHigh() : () => this.playAlarmLow();
    const interval = type === 'high' ? 1350 : 1400;
    fn();
    this.soundInterval = setInterval(fn, interval);
  }

  private stopAlarm() {
    if (this.soundInterval) { clearInterval(this.soundInterval); this.soundInterval = null; }
  }

  // ── Persistencia ──────────────────────────────────────────────────────────
  private async loadPersistedBases() {
    const [partial, deposito] = await Promise.all([
      Preferences.get({ key: PREF_PARTIAL_BASE }),
      Preferences.get({ key: PREF_DEPOSITO_BASE }),
    ]);
    this.partialBase$.next(parseFloat(partial.value   ?? '0') || 0);
    this.depositoBase$.next(parseFloat(deposito.value ?? '0') || 0);
  }

  // ── Polling stats ──────────────────────────────────────────────────────────
  private startStatsPolling() {
    this.stopStatsPolling();
    this.statsInterval = setInterval(() => {
      if (this.bt.isConnected$.value) this.bt.requestRelayStats().catch(() => {});
    }, 2000);
  }

  private stopStatsPolling() {
    if (this.statsInterval) { clearInterval(this.statsInterval); this.statsInterval = null; }
  }

  // ── Navegación ─────────────────────────────────────────────────────────────
  goToBluetoothSettings() { this.router.navigate(['/bt-settings']); }
  openConfigPage()         { this.router.navigate(['/auto-config']); }
  exitApp()                { App.exitApp(); }

  // ── Toggles — con flag anti-rebote y desactivación de relé ────────────────
  async onToggleLeft(event: any) {
    if (this.togglingLeft) return;
    this.togglingLeft = true;
    const enabled = !!event.detail.checked;
    try {
      await this.bt.setSideEnabled('L', enabled);
      if (!enabled) this.bt.relayLeft$.next(false);
    } catch {
      // Revertir visualmente si hay error real
      this.bt.enabledLeft$.next(!enabled);
    } finally {
      this.togglingLeft = false;
    }
  }

  async onToggleRight(event: any) {
    if (this.togglingRight) return;
    this.togglingRight = true;
    const enabled = !!event.detail.checked;
    try {
      await this.bt.setSideEnabled('R', enabled);
      if (!enabled) this.bt.relayRight$.next(false);
    } catch {
      this.bt.enabledRight$.next(!enabled);
    } finally {
      this.togglingRight = false;
    }
  }

  // ── Reset depósito → vuelve a 2000 L ──────────────────────────────────────
  async onResetDeposito() {
    const current = this.bt.totalLitres$.value ?? 0;
    this.depositoBase$.next(current);
    await Preferences.set({ key: PREF_DEPOSITO_BASE, value: String(current) });
  }

  // ── Reset parcial → vuelve a 0 L ──────────────────────────────────────────
  async onResetPartial() {
    const current = this.bt.totalLitres$.value ?? 0;
    this.partialBase$.next(current);
    await Preferences.set({ key: PREF_PARTIAL_BASE, value: String(current) });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  formatMsToMinSec(ms: number | null | undefined): string {
    const safeMs   = Math.max(0, Number(ms ?? 0));
    const totalSec = Math.floor(safeMs / 1000);
    const min      = Math.floor(totalSec / 60);
    const sec      = totalSec % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  pressureEstadoTexto(state: PressureState): string {
    switch (state) {
      case 'high': return 'Presión excesiva';
      case 'low':  return 'Presión insuficiente';
      default:     return 'Correcta';
    }
  }
}