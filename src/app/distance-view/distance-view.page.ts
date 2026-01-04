import { Component, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { BluetoothService } from '../services/bluetooth.service';
import { App } from '@capacitor/app';
import { combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';

import { CommonModule, AsyncPipe, DecimalPipe } from '@angular/common';
import {
  IonToggle, IonHeader, IonToolbar, IonTitle,
  IonContent, IonButtons, IonBackButton,
  IonChip, IonLabel, IonButton, IonIcon
} from '@ionic/angular/standalone';

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
export class DistanceViewPage implements OnDestroy {

  distanceLeft$   = this.bt.distanceLeft$;
  distanceRight$  = this.bt.distanceRight$;
  relayLeft$      = this.bt.relayLeft$;
  relayRight$     = this.bt.relayRight$;
  enabledLeft$    = this.bt.enabledLeft$;
  enabledRight$   = this.bt.enabledRight$;
  isConnected$    = this.bt.isConnected$;
  litersPerMin$   = this.bt.litersPerMin$;
  numApplicators$ = this.bt.numApplicators$;
  mode$           = this.bt.mode$;
  grPerSec$       = this.bt.grPerSec$;

  private statsInterval: any = null;

  // ✅ Stats simplificadas - usa valores directos del servicio
  relayStats$ = combineLatest([
    this.bt.relayLeftTimeMs$,
    this.bt.relayLeftActivations$,
    this.bt.relayRightTimeMs$,
    this.bt.relayRightActivations$,
  ]).pipe(
    map(([leftMs, leftAct, rightMs, rightAct]) => ({
      L: { timeMs: leftMs, activations: leftAct },
      R: { timeMs: rightMs, activations: rightAct }
    }))
  );

  constructor(
    private router: Router,
    public bt: BluetoothService
  ) {}

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
  }

  ngOnDestroy() {
    this.stopStatsPolling();
  }

  private startStatsPolling() {
    this.stopStatsPolling();
    this.statsInterval = setInterval(() => {
      if (this.bt.isConnected$.value) {
        this.bt.requestRelayStats().catch(() => {});
      }
    }, 2000);
  }

  private stopStatsPolling() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  goToBluetoothSettings() { this.router.navigate(['/bt-settings']); }
  openConfigPage() { this.router.navigate(['/auto-config']); }
  exitApp() { App.exitApp(); }

  async onToggleLeft(event: any) {
    const enabled = !!event.detail.checked;
    try { await this.bt.setSideEnabled('L', enabled); } catch (e) { console.error(e); }
  }

  async onToggleRight(event: any) {
    const enabled = !!event.detail.checked;
    try { await this.bt.setSideEnabled('R', enabled); } catch (e) { console.error(e); }
  }

  async onResetStats() {
    try {
      await this.bt.resetRelayStats();
    } catch (e) {
      console.error('Reset stats failed', e);
    }
  }

  formatMsToMinSec(ms: number | null | undefined): string {
    const safeMs = Math.max(0, Number(ms ?? 0));
    const totalSec = Math.floor(safeMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
}

