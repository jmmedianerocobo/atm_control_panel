// src/app/distance-view/distance-view.page.ts

import { Component, OnInit, OnDestroy } from '@angular/core';
import { Observable, interval, combineLatest, Subscription } from 'rxjs';
import { map, startWith, distinctUntilChanged } from 'rxjs/operators';
import { BluetoothService } from '../services/bluetooth.service'; 
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule, AsyncPipe, DecimalPipe } from '@angular/common';
import { 
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonBackButton, 
  IonChip, IonLabel, IonCard, IonCardHeader, IonCardSubtitle, IonCardContent, 
  IonButton, IonIcon, IonToggle 
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
    FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonBackButton, 
    IonChip, IonLabel, IonCard, IonCardHeader, IonCardSubtitle, IonCardContent, 
    IonButton, IonIcon, IonToggle
  ]
})
export class DistanceViewPage implements OnInit, OnDestroy {

  public distanceLeft$!: Observable<number | null>;
  public distanceRight$!: Observable<number | null>;
  public isConnected$!: Observable<boolean>;
  public thresholdCm: number = 30;

  // Observables de tiempo y detección por lado
  public timeBelow30Left$!: Observable<number>;
  public timeBelow30Right$!: Observable<number>;
  public formattedTimeLeft$!: Observable<string>;
  public formattedTimeRight$!: Observable<string>;
  public detectionCountLeft$!: Observable<number>;
  public detectionCountRight$!: Observable<number>;

  // Interruptores
  public toggleLeftActive: boolean = true;
  public toggleRightActive: boolean = false;

  private distanceSubscription: Subscription | undefined;

  private readonly DEBOUNCE_TIME_MS: number = 1000;

  constructor(public bluetoothService: BluetoothService, private router: Router) {}

  ngOnInit() {
    // Observables de conexión
    this.isConnected$ = this.bluetoothService.isConnected$;

    // Observables de distancia correctos desde el servicio
    this.distanceLeft$ = this.bluetoothService.leftDistanceCm$;
    this.distanceRight$ = this.bluetoothService.rightDistanceCm$;

    // Threshold configurable
    this.bluetoothService.configurableThreshold$.subscribe(threshold => {
      this.thresholdCm = threshold;
    });

    // =====================
    // LÓGICA LADO IZQUIERDO
    // =====================
    let startTimeLeft: number | null = null;
    let accumulatedTimeLeft = 0;
    let wasBelow30Left = false;
    let detectionCounterLeft = 0;
    let lastTransitionTimeLeft = 0;

    this.timeBelow30Left$ = combineLatest([
      this.distanceLeft$,
      interval(100).pipe(startWith(0))
    ]).pipe(
      map(([distance, _]) => {
        const isBelow30 = distance !== null && distance < this.thresholdCm;

        if (isBelow30) {
          if (!wasBelow30Left) {
            startTimeLeft = Date.now();
            wasBelow30Left = true;
          }
          const currentSessionTime = startTimeLeft ? (Date.now() - startTimeLeft) / 1000 : 0;
          return accumulatedTimeLeft + currentSessionTime;
        } else {
          if (wasBelow30Left && startTimeLeft) {
            accumulatedTimeLeft += (Date.now() - startTimeLeft) / 1000;
            startTimeLeft = null;
          }
          wasBelow30Left = false;
          return accumulatedTimeLeft;
        }
      })
    );

    this.formattedTimeLeft$ = this.timeBelow30Left$.pipe(
      map((totalSeconds: number) => this.formatTime(totalSeconds))
    );

    this.detectionCountLeft$ = this.distanceLeft$.pipe(
      map(distance => distance !== null && distance < this.thresholdCm),
      distinctUntilChanged(),
      map(isBelow30 => {
        const currentTime = Date.now();
        if (isBelow30) {
          if (currentTime - lastTransitionTimeLeft > this.DEBOUNCE_TIME_MS) {
            detectionCounterLeft++;
            lastTransitionTimeLeft = currentTime;
          }
        }
        return detectionCounterLeft;
      }),
      startWith(0)
    );

    // =====================
    // LÓGICA LADO DERECHO
    // =====================
    let startTimeRight: number | null = null;
    let accumulatedTimeRight = 0;
    let wasBelow30Right = false;
    let detectionCounterRight = 0;
    let lastTransitionTimeRight = 0;

    this.timeBelow30Right$ = combineLatest([
      this.distanceRight$,
      interval(100).pipe(startWith(0))
    ]).pipe(
      map(([distance, _]) => {
        const isBelow30 = distance !== null && distance < this.thresholdCm;

        if (isBelow30) {
          if (!wasBelow30Right) {
            startTimeRight = Date.now();
            wasBelow30Right = true;
          }
          const currentSessionTime = startTimeRight ? (Date.now() - startTimeRight) / 1000 : 0;
          return accumulatedTimeRight + currentSessionTime;
        } else {
          if (wasBelow30Right && startTimeRight) {
            accumulatedTimeRight += (Date.now() - startTimeRight) / 1000;
            startTimeRight = null;
          }
          wasBelow30Right = false;
          return accumulatedTimeRight;
        }
      })
    );

    this.formattedTimeRight$ = this.timeBelow30Right$.pipe(
      map((totalSeconds: number) => this.formatTime(totalSeconds))
    );

    this.detectionCountRight$ = this.distanceRight$.pipe(
      map(distance => distance !== null && distance < this.thresholdCm),
      distinctUntilChanged(),
      map(isBelow30 => {
        const currentTime = Date.now();
        if (isBelow30) {
          if (currentTime - lastTransitionTimeRight > this.DEBOUNCE_TIME_MS) {
            detectionCounterRight++;
            lastTransitionTimeRight = currentTime;
          }
        }
        return detectionCounterRight;
      }),
      startWith(0)
    );
  }

  ngOnDestroy() {
    this.distanceSubscription?.unsubscribe();
  }

  private formatTime(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`;
  }

  resetCounters() {
    // Lado izquierdo
    this.timeBelow30Left$ = combineLatest([this.distanceLeft$, interval(100).pipe(startWith(0))])
      .pipe(map(() => 0));
    this.detectionCountLeft$ = combineLatest([this.distanceLeft$]).pipe(map(() => 0));

    // Lado derecho
    this.timeBelow30Right$ = combineLatest([this.distanceRight$, interval(100).pipe(startWith(0))])
      .pipe(map(() => 0));
    this.detectionCountRight$ = combineLatest([this.distanceRight$]).pipe(map(() => 0));

    console.log('Contadores reseteados (Tiempo y Detecciones).');
  }

  goToBluetoothSettings() {
    this.router.navigate(['/bt-settings']);
  }

  onToggleChange(column: 'left' | 'right') {
    if (column === 'left') {
      console.log(`Interruptor Lado Izquierdo: ${this.toggleLeftActive ? 'ACTIVADO' : 'DESACTIVADO'}`);
      this.bluetoothService.sendCommand(`TOGGLE_LEFT:${this.toggleLeftActive ? 'ON' : 'OFF'}`);
    } else if (column === 'right') {
      console.log(`Interruptor Lado Derecho: ${this.toggleRightActive ? 'ACTIVADO' : 'DESACTIVADO'}`);
      this.bluetoothService.sendCommand(`TOGGLE_RIGHT:${this.toggleRightActive ? 'ON' : 'OFF'}`);
    }
  }
}
