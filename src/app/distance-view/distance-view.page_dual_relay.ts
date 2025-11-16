import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Observable, Subscription, map } from 'rxjs';

import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonBackButton,
  IonButton,
  IonIcon,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardContent,
  IonCardSubtitle,
  IonToggle,
  IonChip,
  IonLabel
} from '@ionic/angular/standalone';

import { addIcons } from 'ionicons';
import { 
  bluetoothOutline, 
  refreshOutline,
  settingsOutline
} from 'ionicons/icons';

import { BluetoothService, DistanceTracking } from '../services/bluetooth.service_dual_relay'; 

@Component({
  selector: 'app-distance-view',
  templateUrl: './distance-view.page.html',
  styleUrls: ['./distance-view.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButtons,
    IonBackButton,
    IonButton,
    IonIcon,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonCardSubtitle,
    IonToggle,
    IonChip,
    IonLabel
  ]
})
export class DistanceViewPage implements OnInit, OnDestroy {

  public toggleLeftActive: boolean = false;
  public toggleRightActive: boolean = false;
  public thresholdCm: number = 10;

  public isConnected$: Observable<boolean> = this.bluetoothService.isConnected$;
  public distanceLeft$: Observable<number | null> = this.bluetoothService.trackingState$.pipe(map(state => state.distanceLeft));
  public formattedTimeLeft$: Observable<string> = this.bluetoothService.trackingState$.pipe(map(state => state.formattedTimeLeft));
  public detectionCountLeft$: Observable<number> = this.bluetoothService.trackingState$.pipe(map(state => state.detectionCountLeft));
  public distanceRight$: Observable<number | null> = this.bluetoothService.trackingState$.pipe(map(state => state.distanceRight));
  public formattedTimeRight$: Observable<string> = this.bluetoothService.trackingState$.pipe(map(state => state.formattedTimeRight));
  public detectionCountRight$: Observable<number> = this.bluetoothService.trackingState$.pipe(map(state => state.detectionCountRight));

  private subscriptions: Subscription[] = [];

  constructor(
    public bluetoothService: BluetoothService,
    private router: Router
  ) {
    addIcons({ 
      bluetoothOutline, 
      refreshOutline,
      settingsOutline
    });
  }

  ngOnInit() {
    this.subscriptions.push(
      this.bluetoothService.trackingState$.subscribe((state: DistanceTracking) => {
        this.toggleLeftActive = state.relayLeftActive;
        this.toggleRightActive = state.relayRightActive;
      }),
      this.bluetoothService.configurableThreshold$.subscribe((threshold: number) => { 
        this.thresholdCm = threshold;
      })
    );
  }

  goToBluetoothSettings() {
    this.router.navigateByUrl('/bt-settings');
  }

  // ✅ MÉTODO CORREGIDO - Ahora envía ON y OFF
  onToggleChange(side: 'left' | 'right', event: any) {
    const isActive = event.detail.checked;
    
    if (side === 'left') {
      this.toggleLeftActive = isActive;
      this.bluetoothService.toggleRelayLeft(isActive);
      console.log(`[UI] Toggle LEFT ${isActive ? 'ON' : 'OFF'}`); // ✅ CORREGIDO: Faltaba paréntesis
    } else {
      this.toggleRightActive = isActive;
      this.bluetoothService.toggleRelayRight(isActive);
      console.log(`[UI] Toggle RIGHT ${isActive ? 'ON' : 'OFF'}`); // ✅ CORREGIDO: Faltaba paréntesis
    }
  }

  resetCounters() {
    this.bluetoothService.countersReset();
  }

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }
}