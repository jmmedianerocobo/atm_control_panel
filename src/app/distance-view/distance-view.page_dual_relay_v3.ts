import { Component, OnInit, OnDestroy } from '@angular/core';
import { Observable, Subscription } from 'rxjs';
import { BluetoothService } from '../services/bluetooth.service';
import { Router } from '@angular/router';
import {
  AsyncPipe,
  DecimalPipe,
  CommonModule,
} from '@angular/common';
import {
  IonToggle,
  IonCard,
  IonCardHeader,
  IonCardSubtitle,
  IonCardContent,
  IonButton,
  IonIcon,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonBackButton,
  IonChip,
  IonLabel,
} from '@ionic/angular/standalone';

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
    IonCard, IonCardHeader, IonCardSubtitle, IonCardContent,
    IonHeader, IonToolbar, IonTitle,
    IonContent, IonButtons, IonBackButton,
    IonChip, IonLabel, IonButton, IonIcon,
  ],
})
export class DistanceViewPage implements OnInit, OnDestroy {

  distanceLeft$!: Observable<number | null>;
  distanceRight$!: Observable<number | null>;
  isConnected$!: Observable<boolean>;

  // Toggles para activar/desactivar lógica independiente
  toggleLeftActive = true;
  toggleRightActive = true;

  // Estado interno de cada relé
  private relayLeftActive = false;
  private relayRightActive = false;

  // Subscripciones
  private leftSub?: Subscription;
  private rightSub?: Subscription;
  private configSubs: Subscription[] = [];

  // Parámetros configurables (sincronizados con AutoConfig)
  thresholdCm = 30;
  hysteresisCm = 10;
  holdTimeMs = 300;
  maxValidDistanceCm = 250;

  // Timers internos para holdTime
  private leftBelowStart: number | null = null;
  private leftAboveStart: number | null = null;
  private rightBelowStart: number | null = null;
  private rightAboveStart: number | null = null;

  constructor(
    public bluetoothService: BluetoothService,
    private router: Router
  ) {}

  ngOnInit() {
    console.log('[DistanceView] ngOnInit');

    this.distanceLeft$ = this.bluetoothService.distanceLeft$;
    this.distanceRight$ = this.bluetoothService.distanceRight$;
    this.isConnected$ = this.bluetoothService.isConnected$;

    // Sync config with BluetoothService persistent storage
    this.configSubs.push(
      this.bluetoothService.thresholdCm$.subscribe(v => this.thresholdCm = v),
      this.bluetoothService.hysteresisCm$.subscribe(v => this.hysteresisCm = v),
      this.bluetoothService.holdTimeMs$.subscribe(v => this.holdTimeMs = v),
    );

    console.log('[CFG] threshold =', this.thresholdCm,
                'hyst =', this.hysteresisCm,
                'hold =', this.holdTimeMs);
  }

  ionViewWillEnter() {
    console.log('[DistanceView] ionViewWillEnter');

    this.leftSub = this.distanceLeft$.subscribe(d => this.evaluateLeft(d));
    this.rightSub = this.distanceRight$.subscribe(d => this.evaluateRight(d));
  }

  ionViewWillLeave() {
    console.log('[DistanceView] ionViewWillLeave');

    this.leftSub?.unsubscribe();
    this.rightSub?.unsubscribe();
  }

  ngOnDestroy() {
    console.log('[DistanceView] ngOnDestroy');

    this.leftSub?.unsubscribe();
    this.rightSub?.unsubscribe();
    this.configSubs.forEach(s => s.unsubscribe());
  }

  // ======================================================
  //        LÓGICA DE CONTROL LEFT (con histéresis)
  // ======================================================
  private evaluateLeft(distance: number | null) {
    if (!this.toggleLeftActive || distance === null) return;

    let d = Math.min(distance, this.maxValidDistanceCm);

    const now = Date.now();
    const onThreshold = this.thresholdCm;
    const offThreshold = this.thresholdCm + this.hysteresisCm;

    if (!this.relayLeftActive) {
      if (d < onThreshold) {
        if (!this.leftBelowStart) this.leftBelowStart = now;

        if (now - this.leftBelowStart >= this.holdTimeMs) {
          console.log('[LEFT] Activando (d=', d, ')');
          this.bluetoothService.activateLeft();
          this.relayLeftActive = true;
          this.leftBelowStart = null;
        }
      } else {
        this.leftBelowStart = null;
      }
    } else {
      if (d > offThreshold) {
        if (!this.leftAboveStart) this.leftAboveStart = now;

        if (now - this.leftAboveStart >= this.holdTimeMs) {
          console.log('[LEFT] Desactivando (d=', d, ')');
          this.bluetoothService.deactivateLeft();
          this.relayLeftActive = false;
          this.leftAboveStart = null;
        }
      } else {
        this.leftAboveStart = null;
      }
    }
  }

  // ======================================================
  //        LÓGICA DE CONTROL RIGHT (con histéresis)
  // ======================================================
  private evaluateRight(distance: number | null) {
    if (!this.toggleRightActive || distance === null) return;

    let d = Math.min(distance, this.maxValidDistanceCm);

    const now = Date.now();
    const onThreshold = this.thresholdCm;
    const offThreshold = this.thresholdCm + this.hysteresisCm;

    if (!this.relayRightActive) {
      if (d < onThreshold) {
        if (!this.rightBelowStart) this.rightBelowStart = now;

        if (now - this.rightBelowStart >= this.holdTimeMs) {
          console.log('[RIGHT] Activando (d=', d, ')');
          this.bluetoothService.activateRight();
          this.relayRightActive = true;
          this.rightBelowStart = null;
        }
      } else {
        this.rightBelowStart = null;
      }
    } else {
      if (d > offThreshold) {
        if (!this.rightAboveStart) this.rightAboveStart = now;

        if (now - this.rightAboveStart >= this.holdTimeMs) {
          console.log('[RIGHT] Desactivando (d=', d, ')');
          this.bluetoothService.deactivateRight();
          this.relayRightActive = false;
          this.rightAboveStart = null;
        }
      } else {
        this.rightAboveStart = null;
      }
    }
  }

  // ======================================================
  // NAVEGACIÓN
  // ======================================================
  goToBluetoothSettings() {
    this.router.navigate(['/bt-settings']);
  }

  openConfigPage() {
    this.router.navigate(['/auto-config']);
  }
}

