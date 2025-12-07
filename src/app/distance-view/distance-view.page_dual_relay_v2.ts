import { Component, OnInit, OnDestroy } from '@angular/core';
import { Observable, interval, combineLatest, Subscription } from 'rxjs';
import { map, startWith, distinctUntilChanged, tap } from 'rxjs/operators';
import { BluetoothService } from '../services/bluetooth.service'; 
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule, AsyncPipe, DecimalPipe } from '@angular/common';
import { 
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonBackButton, 
  IonChip, IonLabel, IonCard, IonCardHeader, IonCardSubtitle, IonCardContent, 
  IonButton, IonIcon, IonToggle,
  ViewWillEnter, ViewWillLeave  // ← Importar aquí
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
export class DistanceViewPage implements OnInit, OnDestroy, ViewWillEnter, ViewWillLeave {

  public distanceLeft$!: Observable<number | null>;
  public distanceRight$!: Observable<number | null>;
  public isConnected$!: Observable<boolean>;
  public thresholdCm: number = 30;

  // Observables de tiempo y detección
  public timeBelow30Left$!: Observable<number>;
  public timeBelow30Right$!: Observable<number>;
  public formattedTimeLeft$!: Observable<string>;
  public formattedTimeRight$!: Observable<string>;
  public detectionCountLeft$!: Observable<number>;
  public detectionCountRight$!: Observable<number>;

  // ✅ Estado inicial: AMBOS OFF
  public toggleLeftActive: boolean = true;
  public toggleRightActive: boolean = true;

  // ✅ Estados REALES de los relés
  private relayLeftActive: boolean = false;
  private relayRightActive: boolean = false;

  private leftSubscription: Subscription | undefined;
  private rightSubscription: Subscription | undefined;
  private readonly DEBOUNCE_TIME_MS: number = 1000;

  constructor(
    public bluetoothService: BluetoothService, 
    private router: Router
  ) {
    // ✅ DEBUG: Exponer componente
    (window as any).distanceView = this;
    console.log('%c[Constructor] ✅ Componente expuesto en window.distanceView', 'background: #9C27B0; color: white; padding: 2px 6px;');
  }

  ngOnInit() {
    console.log('%c[ngOnInit] 🏗️ Componente creado', 'background: #3F51B5; color: white; padding: 2px 6px;');
    
    this.isConnected$ = this.bluetoothService.isConnected$;
    this.distanceLeft$ = this.bluetoothService.leftDistanceCm$;
    this.distanceRight$ = this.bluetoothService.rightDistanceCm$;

    // Threshold
    this.bluetoothService.configurableThreshold$.subscribe(threshold => {
      this.thresholdCm = threshold;
      console.log(`%c[Config] Umbral: ${threshold}cm`, 'color: #FF9800;');
    });

    this.setupCounters();
  }

  // ✅ SE EJECUTA CADA VEZ QUE ENTRAS A LA PÁGINA
  ionViewWillEnter() {
    console.log('%c╔════════════════════════════════════════════════╗', 'color: #2196F3; font-weight: bold;');
    console.log('%c║  ENTRANDO A DISTANCE VIEW v5.4 DUAL           ║', 'background: #2196F3; color: white; font-size: 14px; padding: 4px;');
    console.log('%c╚════════════════════════════════════════════════╝', 'color: #2196F3; font-weight: bold;');
    console.log('%c[ionViewWillEnter] Estado inicial:', 'font-weight: bold;', {
      toggleLeft: this.toggleLeftActive,
      toggleRight: this.toggleRightActive,
      relayLeft: this.relayLeftActive,
      relayRight: this.relayRightActive,
      threshold: this.thresholdCm
    });
    
    // Limpiar suscripciones anteriores si existen
    this.leftSubscription?.unsubscribe();
    this.rightSubscription?.unsubscribe();
    
    // ✅ CREAR SUSCRIPCIÓN PARA LEFT
    console.log('%c[ionViewWillEnter] 🎧 Iniciando suscripción a distancia LEFT...', 'background: #FF9800; color: white; padding: 2px 6px;');
    
    this.leftSubscription = this.distanceLeft$.pipe(
      tap(distance => {
        console.log(`%c[RX] 📏 Distancia LEFT: ${distance}cm`, 'color: #FF9800;');
      })
    ).subscribe(distance => {
      this.handleLeftDistance(distance);
    });
    
    // ✅ CREAR SUSCRIPCIÓN PARA RIGHT
    console.log('%c[ionViewWillEnter] 🎧 Iniciando suscripción a distancia RIGHT...', 'background: #4CAF50; color: white; padding: 2px 6px;');
    
    this.rightSubscription = this.distanceRight$.pipe(
      tap(distance => {
        console.log(`%c[RX] 📏 Distancia RIGHT: ${distance}cm`, 'color: #2196F3;');
      })
    ).subscribe(distance => {
      this.handleRightDistance(distance);
    });
    
    console.log('%c[ionViewWillEnter] ✅ Suscripciones LEFT y RIGHT creadas correctamente', 'background: #4CAF50; color: white; padding: 2px 6px;');
  }

  // ✅ SE EJECUTA CADA VEZ QUE SALES DE LA PÁGINA
  ionViewWillLeave() {
    console.log('%c[ionViewWillLeave] 🚪 Saliendo de Distance View...', 'background: #607D8B; color: white; padding: 2px 6px;');
    
    // Apagar relés
    if (this.relayLeftActive) {
      console.log('%c[ionViewWillLeave] 🔴 Apagando relé LEFT', 'color: #f44336; font-weight: bold;');
      this.bluetoothService.sendCommand('deactivateLeft');
      this.relayLeftActive = false;
    }
    
    if (this.relayRightActive) {
      console.log('%c[ionViewWillLeave] 🔴 Apagando relé RIGHT', 'color: #f44336; font-weight: bold;');
      this.bluetoothService.sendCommand('deactivateRight');
      this.relayRightActive = false;
    }
    
    // Desuscribir
    this.leftSubscription?.unsubscribe();
    this.rightSubscription?.unsubscribe();
    console.log('%c[ionViewWillLeave] ✅ Limpieza completada', 'color: #607D8B;');
  }

  // ===================================
  // ✅ LÓGICA SIMPLIFICADA - LEFT
  // ===================================
  private handleLeftDistance(distance: number | null) {
    console.group(`%c[LEFT] 📊 Evaluación`, 'background: #FF9800; color: white; padding: 2px 6px;');
    console.log('Distancia:', distance);
    console.log('Toggle:', this.toggleLeftActive ? 'ON 🟢' : 'OFF ⚫');
    console.log('Relé actual:', this.relayLeftActive ? 'ON ⚡' : 'OFF 💤');
    console.log('Umbral:', this.thresholdCm);

    // 1. Si toggle está OFF
    if (!this.toggleLeftActive) {
      console.log('%c[LEFT] Toggle OFF → Verificando relé...', 'color: #FF9800;');
      if (this.relayLeftActive) {
        console.log('%c[LEFT] 🔴 DESACTIVANDO relé (toggle OFF)', 'background: #f44336; color: white; font-weight: bold; padding: 4px 8px;');
        this.bluetoothService.sendCommand('deactivateLeft');
        this.relayLeftActive = false;
      } else {
        console.log('%c[LEFT] ✅ Relé ya está OFF', 'color: #607D8B;');
      }
      console.groupEnd();
      return;
    }

    // 2. Si no hay distancia válida
    if (distance === null) {
      console.log('%c[LEFT] ⚠️ Distancia NULL → No hacer nada', 'color: #FF9800;');
      console.groupEnd();
      return;
    }

    // 3. Determinar estado deseado
    const shouldBeActive = distance < this.thresholdCm;
    console.log(`Evaluación: ${distance}cm ${shouldBeActive ? '<' : '>'} ${this.thresholdCm}cm → Relé debe estar: ${shouldBeActive ? 'ON' : 'OFF'}`);

    // 4. Aplicar cambio si es necesario
    if (shouldBeActive && !this.relayLeftActive) {
      // ACTIVAR
      console.log('%c[LEFT] 🟢 ACTIVANDO RELÉ', 'background: #4CAF50; color: white; font-weight: bold; font-size: 14px; padding: 8px;');
      console.log('Motivo: Distancia', distance, '< Umbral', this.thresholdCm);
      this.bluetoothService.sendCommand('activateLeft');
      this.relayLeftActive = true;
    } 
    else if (!shouldBeActive && this.relayLeftActive) {
      // DESACTIVAR
      console.log('%c[LEFT] 🔴 DESACTIVANDO RELÉ', 'background: #f44336; color: white; font-weight: bold; font-size: 14px; padding: 8px;');
      console.log('Motivo: Distancia', distance, '> Umbral', this.thresholdCm);
      this.bluetoothService.sendCommand('deactivateLeft');
      this.relayLeftActive = false;
    } 
    else {
      console.log('%c[LEFT] ➡️ Sin cambio necesario', 'color: #9E9E9E;');
    }

    console.groupEnd();
  }

  // ===================================
  // ✅ LÓGICA SIMPLIFICADA - RIGHT
  // ===================================
  private handleRightDistance(distance: number | null) {
    console.group(`%c[RIGHT] 📊 Evaluación`, 'background: #9C27B0; color: white; padding: 2px 6px;');
    console.log('Distancia:', distance);
    console.log('Toggle:', this.toggleRightActive ? 'ON 🟢' : 'OFF ⚫');
    console.log('Relé actual:', this.relayRightActive ? 'ON ⚡' : 'OFF 💤');
    console.log('Umbral:', this.thresholdCm);

    // 1. Si toggle está OFF
    if (!this.toggleRightActive) {
      console.log('%c[RIGHT] Toggle OFF → Verificando relé...', 'color: #FF9800;');
      if (this.relayRightActive) {
        console.log('%c[RIGHT] 🔴 DESACTIVANDO relé (toggle OFF)', 'background: #f44336; color: white; font-weight: bold; padding: 4px 8px;');
        this.bluetoothService.sendCommand('deactivateRight');
        this.relayRightActive = false;
      } else {
        console.log('%c[RIGHT] ✅ Relé ya está OFF', 'color: #607D8B;');
      }
      console.groupEnd();
      return;
    }

    // 2. Si no hay distancia válida
    if (distance === null) {
      console.log('%c[RIGHT] ⚠️ Distancia NULL → No hacer nada', 'color: #FF9800;');
      console.groupEnd();
      return;
    }

    // 3. Determinar estado deseado
    const shouldBeActive = distance < this.thresholdCm;
    console.log(`Evaluación: ${distance}cm ${shouldBeActive ? '<' : '>'} ${this.thresholdCm}cm → Relé debe estar: ${shouldBeActive ? 'ON' : 'OFF'}`);

    // 4. Aplicar cambio si es necesario
    if (shouldBeActive && !this.relayRightActive) {
      // ACTIVAR
      console.log('%c[RIGHT] 🟢 ACTIVANDO RELÉ', 'background: #4CAF50; color: white; font-weight: bold; font-size: 14px; padding: 8px;');
      console.log('Motivo: Distancia', distance, '< Umbral', this.thresholdCm);
      this.bluetoothService.sendCommand('activateRight');
      this.relayRightActive = true;
    } 
    else if (!shouldBeActive && this.relayRightActive) {
      // DESACTIVAR
      console.log('%c[RIGHT] 🔴 DESACTIVANDO RELÉ', 'background: #f44336; color: white; font-weight: bold; font-size: 14px; padding: 8px;');
      console.log('Motivo: Distancia', distance, '> Umbral', this.thresholdCm);
      this.bluetoothService.sendCommand('deactivateRight');
      this.relayRightActive = false;
    } 
    else {
      console.log('%c[RIGHT] ➡️ Sin cambio necesario', 'color: #9E9E9E;');
    }

    console.groupEnd();
  }

  ngOnDestroy() {
    console.log('%c[Destroy] 🧹 Componente destruido', 'background: #607D8B; color: white; padding: 2px 6px;');
    this.leftSubscription?.unsubscribe();
    this.rightSubscription?.unsubscribe();
  }

  // ===================================
  // ✅ CONTROL DE TOGGLES LEFT Y RIGHT
  // ===================================
  onToggleChange(column: 'left' | 'right') {
    if (column === 'left') {
      console.log('%c╔════════════════════════════════════════════════╗', 'color: #FF9800; font-weight: bold;');
      console.log(`%c║  TOGGLE LEFT: ${this.toggleLeftActive ? 'ACTIVADO 🟢' : 'DESACTIVADO ⚫'}  ║`, 
                  `background: ${this.toggleLeftActive ? '#4CAF50' : '#f44336'}; color: white; font-size: 16px; padding: 8px; font-weight: bold;`);
      console.log('%c╚════════════════════════════════════════════════╝', 'color: #FF9800; font-weight: bold;');
      
      const currentDistance = this.bluetoothService.distanceLeftSubject.value;
      console.log(`%c[Toggle] Distancia actual LEFT: ${currentDistance}cm`, 'color: #FF9800; font-weight: bold;');
      
      if (this.toggleLeftActive) {
        // ✅ ACTIVADO
        console.log('%c[Toggle] ✅ Control HABILITADO', 'background: #4CAF50; color: white; padding: 4px 8px;');
        console.log('%c[Toggle] Evaluando inmediatamente...', 'color: #4CAF50;');
        
        // Forzar evaluación inmediata
        this.handleLeftDistance(currentDistance);
        
      } else {
        // ❌ DESACTIVADO
        console.log('%c[Toggle] ❌ Control DESHABILITADO', 'background: #f44336; color: white; padding: 4px 8px;');
        
        if (this.relayLeftActive) {
          console.log('%c[Toggle] Forzando desactivación del relé...', 'color: #f44336; font-weight: bold;');
          this.bluetoothService.sendCommand('deactivateLeft');
          this.relayLeftActive = false;
        } else {
          console.log('%c[Toggle] Relé ya estaba OFF', 'color: #607D8B;');
        }
      }
      
      console.log('%c════════════════════════════════════════════════', 'color: #FF9800; font-weight: bold;');
    }
    else if (column === 'right') {
      console.log('%c╔════════════════════════════════════════════════╗', 'color: #4CAF50; font-weight: bold;');
      console.log(`%c║  TOGGLE RIGHT: ${this.toggleRightActive ? 'ACTIVADO 🟢' : 'DESACTIVADO ⚫'}  ║`, 
                  `background: ${this.toggleRightActive ? '#4CAF50' : '#f44336'}; color: white; font-size: 16px; padding: 8px; font-weight: bold;`);
      console.log('%c╚════════════════════════════════════════════════╝', 'color: #4CAF50; font-weight: bold;');
      
      const currentDistance = this.bluetoothService.distanceRightSubject.value;
      console.log(`%c[Toggle] Distancia actual RIGHT: ${currentDistance}cm`, 'color: #2196F3; font-weight: bold;');
      
      if (this.toggleRightActive) {
        // ✅ ACTIVADO
        console.log('%c[Toggle] ✅ Control HABILITADO', 'background: #4CAF50; color: white; padding: 4px 8px;');
        console.log('%c[Toggle] Evaluando inmediatamente...', 'color: #4CAF50;');
        
        // Forzar evaluación inmediata
        this.handleRightDistance(currentDistance);
        
      } else {
        // ❌ DESACTIVADO
        console.log('%c[Toggle] ❌ Control DESHABILITADO', 'background: #f44336; color: white; padding: 4px 8px;');
        
        if (this.relayRightActive) {
          console.log('%c[Toggle] Forzando desactivación del relé...', 'color: #f44336; font-weight: bold;');
          this.bluetoothService.sendCommand('deactivateRight');
          this.relayRightActive = false;
        } else {
          console.log('%c[Toggle] Relé ya estaba OFF', 'color: #607D8B;');
        }
      }
      
      console.log('%c════════════════════════════════════════════════', 'color: #4CAF50; font-weight: bold;');
    }
  }

  // ===================================
  // SETUP DE CONTADORES
  // ===================================
  private setupCounters() {
    // LEFT (simplificado)
    this.timeBelow30Left$ = combineLatest([this.distanceLeft$, interval(100).pipe(startWith(0))])
      .pipe(map(() => 0));
    this.formattedTimeLeft$ = this.timeBelow30Left$.pipe(map(() => '00:00'));
    this.detectionCountLeft$ = this.distanceLeft$.pipe(map(() => 0), startWith(0));

    // RIGHT
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

  private formatTime(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`;
  }

  resetCounters() {
    console.log('%c[Reset] 🔄 Reseteando contadores...', 'background: #9C27B0; color: white; padding: 2px 6px;');
    window.location.reload();
  }

  goToBluetoothSettings() {
    this.router.navigate(['/bt-settings']);
  }

  // ===================================
  // ✅ MÉTODOS DE DEBUG MANUAL
  // ===================================
  public debugStatus() {
    console.log('%c╔════════════════════════════════════════╗', 'color: blue; font-weight: bold;');
    console.log('%c║         ESTADO ACTUAL                  ║', 'background: blue; color: white; padding: 4px;');
    console.log('%c╚════════════════════════════════════════╝', 'color: blue; font-weight: bold;');
    console.table({
      'Toggle LEFT': this.toggleLeftActive ? '🟢 ON' : '⚫ OFF',
      'Relé LEFT': this.relayLeftActive ? '⚡ ON' : '💤 OFF',
      'Distancia LEFT': (this.bluetoothService.distanceLeftSubject.value ?? 'NULL') + ' cm',
      'Toggle RIGHT': this.toggleRightActive ? '🟢 ON' : '⚫ OFF',
      'Relé RIGHT': this.relayRightActive ? '⚡ ON' : '💤 OFF',
      'Distancia RIGHT': (this.bluetoothService.distanceRightSubject.value ?? 'NULL') + ' cm',
      'Umbral': this.thresholdCm + ' cm',
      'Bluetooth': this.bluetoothService.isConnectedSubject.value ? '✅ Conectado' : '❌ Desconectado'
    });
  }

  public forceEvaluateLeft() {
    console.log('%c[Manual] 🔧 Forzando evaluación LEFT...', 'background: #FF9800; color: black; font-weight: bold; padding: 4px;');
    const distance = this.bluetoothService.distanceLeftSubject.value;
    this.handleLeftDistance(distance);
  }

  public forceEvaluateRight() {
    console.log('%c[Manual] 🔧 Forzando evaluación RIGHT...', 'background: #FF9800; color: black; font-weight: bold; padding: 4px;');
    const distance = this.bluetoothService.distanceRightSubject.value;
    this.handleRightDistance(distance);
  }

  public testActivateLeft() {
    console.log('%c[Test] ⚡ TEST: Activando relé LEFT manualmente', 'background: red; color: white; font-weight: bold; padding: 8px;');
    this.bluetoothService.sendCommand('activateLeft');
    this.relayLeftActive = true;
  }

  public testDeactivateLeft() {
    console.log('%c[Test] 💤 TEST: Desactivando relé LEFT manualmente', 'background: gray; color: white; font-weight: bold; padding: 8px;');
    this.bluetoothService.sendCommand('deactivateLeft');
    this.relayLeftActive = false;
  }

  public testActivateRight() {
    console.log('%c[Test] ⚡ TEST: Activando relé RIGHT manualmente', 'background: red; color: white; font-weight: bold; padding: 8px;');
    this.bluetoothService.sendCommand('activateRight');
    this.relayRightActive = true;
  }

  public testDeactivateRight() {
    console.log('%c[Test] 💤 TEST: Desactivando relé RIGHT manualmente', 'background: gray; color: white; font-weight: bold; padding: 8px;');
    this.bluetoothService.sendCommand('deactivateRight');
    this.relayRightActive = false;
  }
}