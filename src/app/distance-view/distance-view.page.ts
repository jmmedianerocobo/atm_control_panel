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
  public toggleRightActive: boolean = true;

  private distanceSubscription: Subscription | undefined;
  private signalSubscription: Subscription | undefined;

  // Variables de estado para la lógica de activación de señales
  private wasLeftBelowThreshold: boolean = false;
  private wasRightBelowThreshold: boolean = false;

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

    // ===================================
    // LÓGICA DE ACTIVACIÓN/DESACTIVACIÓN DE SEÑALES
    // ===================================
    this.signalSubscription = combineLatest([
      this.distanceLeft$.pipe(distinctUntilChanged()),
      this.distanceRight$.pipe(distinctUntilChanged())
    ]).subscribe(([leftDistance, rightDistance]) => {
        // --- Lado Izquierdo ---
        if (leftDistance !== null && this.toggleLeftActive) {
          const isLeftBelowThreshold = leftDistance < this.thresholdCm;

          if (isLeftBelowThreshold && !this.wasLeftBelowThreshold) {
            // Transición: De fuera a dentro del umbral -> ACTIVA
            this.bluetoothService.sendCommand('activateLeft');
            console.log('SEÑAL: activateLeft enviada.');
          } else if (!isLeftBelowThreshold && this.wasLeftBelowThreshold) {
            // Transición: De dentro a fuera del umbral -> DESACTIVA
            this.bluetoothService.sendCommand('deactivateLeft');
            console.log('SEÑAL: deactivateLeft enviada.');
          }
          this.wasLeftBelowThreshold = isLeftBelowThreshold;
        } else if (!this.toggleLeftActive) {
          // Si el toggle está inactivo, resetea el estado para la próxima activación
          this.wasLeftBelowThreshold = false;
        }

        // --- Lado Derecho ---
        if (rightDistance !== null && this.toggleRightActive) {
          const isRightBelowThreshold = rightDistance < this.thresholdCm;

          if (isRightBelowThreshold && !this.wasRightBelowThreshold) {
            // Transición: De fuera a dentro del umbral -> ACTIVA
            this.bluetoothService.sendCommand('activateRight');
            console.log('SEÑAL: activateRight enviada.');
          } else if (!isRightBelowThreshold && this.wasRightBelowThreshold) {
            // Transición: De dentro a fuera del umbral -> DESACTIVA
            this.bluetoothService.sendCommand('deactivateRight');
            console.log('SEÑAL: deactivateRight enviada.');
          }
          this.wasRightBelowThreshold = isRightBelowThreshold;
        } else if (!this.toggleRightActive) {
          // Si el toggle está inactivo, resetea el estado para la próxima activación
          this.wasRightBelowThreshold = false;
        }
    });
    // ===================================

    // =====================
    // LÓGICA LADO IZQUIERDO (Conteo de tiempo y detecciones)
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
        if (!this.toggleLeftActive) {
          // Si el toggle está OFF, detenemos cualquier sesión de conteo activa
          if (wasBelow30Left && startTimeLeft) {
            accumulatedTimeLeft += (Date.now() - startTimeLeft) / 1000;
            startTimeLeft = null;
          }
          wasBelow30Left = false;
          return accumulatedTimeLeft;
        }
        
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
        if (!this.toggleLeftActive) {
          return detectionCounterLeft;
        }

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
    // LÓGICA LADO DERECHO (Conteo de tiempo y detecciones)
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
        if (!this.toggleRightActive) {
          if (wasBelow30Right && startTimeRight) {
            accumulatedTimeRight += (Date.now() - startTimeRight) / 1000;
            startTimeRight = null;
          }
          wasBelow30Right = false;
          return accumulatedTimeRight;
        }
        
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
        if (!this.toggleRightActive) {
          return detectionCounterRight;
        }

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
    this.signalSubscription?.unsubscribe();
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

  // ========================================
  // 🆕 CONTROL DE TOGGLES CORREGIDO
  // ========================================
  onToggleChange(column: 'left' | 'right') {
    if (column === 'left') {
      console.log(`Interruptor Lado Izquierdo: ${this.toggleLeftActive ? 'ACTIVADO' : 'DESACTIVADO'}`);
      
      if (this.toggleLeftActive) {
        // ✅ Toggle ACTIVADO
        this.bluetoothService.sendCommand(`TOGGLE_LEFT:ON`);
        
        // Si hay un objeto dentro del umbral al momento de activar, activar inmediatamente
        const currentDistance = this.bluetoothService.distanceLeftSubject.value;
        if (currentDistance !== null && currentDistance < this.thresholdCm) {
          this.bluetoothService.sendCommand('activateLeft');
          this.wasLeftBelowThreshold = true;
          console.log('SEÑAL: activateLeft (activación inmediata por toggle ON con objeto presente).');
        }
      } else {
        // ✅ Toggle DESACTIVADO
        this.bluetoothService.sendCommand(`TOGGLE_LEFT:OFF`);
        
        // ✅ CORRECCIÓN CRÍTICA: NO enviar deactivateLeft
        // El comando TOGGLE_LEFT:OFF resetea el Arduino a modo automático
        // Si es necesario apagar el relé, el Arduino lo hará automáticamente
        
        console.log('SEÑAL: TOGGLE_LEFT:OFF enviada. Arduino resetea a modo automático.');
        
        // Resetear estado interno para la próxima activación
        this.wasLeftBelowThreshold = false;
      }
    } 
    else if (column === 'right') {
      console.log(`Interruptor Lado Derecho: ${this.toggleRightActive ? 'ACTIVADO' : 'DESACTIVADO'}`);
      
      if (this.toggleRightActive) {
        // ✅ Toggle ACTIVADO
        this.bluetoothService.sendCommand(`TOGGLE_RIGHT:ON`);
        
        // Si hay un objeto dentro del umbral al momento de activar, activar inmediatamente
        const currentDistance = this.bluetoothService.distanceRightSubject.value;
        if (currentDistance !== null && currentDistance < this.thresholdCm) {
          this.bluetoothService.sendCommand('activateRight');
          this.wasRightBelowThreshold = true;
          console.log('SEÑAL: activateRight (activación inmediata por toggle ON con objeto presente).');
        }
      } else {
        // ✅ Toggle DESACTIVADO
        this.bluetoothService.sendCommand(`TOGGLE_RIGHT:OFF`);
        
        // ✅ CORRECCIÓN CRÍTICA: NO enviar deactivateRight
        // El comando TOGGLE_RIGHT:OFF resetea el Arduino a modo automático
        
        console.log('SEÑAL: TOGGLE_RIGHT:OFF enviada. Arduino resetea a modo automático.');
        
        // Resetear estado interno para la próxima activación
        this.wasRightBelowThreshold = false;
      }
    }
  }
}