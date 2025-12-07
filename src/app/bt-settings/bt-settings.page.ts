import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { BluetoothService, BluetoothDevice } from '../services/bluetooth.service';

import {
  IonHeader, IonToolbar, IonTitle,
  IonContent, IonButtons, IonBackButton,
  IonCard, IonCardHeader, IonCardTitle, IonCardContent,
  IonButton, IonLabel, IonItem, IonList, IonChip, IonSpinner
} from '@ionic/angular/standalone';

@Component({
  selector: 'app-bt-settings',
  templateUrl: './bt-settings.page.html',
  styleUrls: ['./bt-settings.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    IonHeader, IonToolbar, IonTitle,
    IonContent, IonButtons, IonBackButton,
    IonCard, IonCardHeader, IonCardTitle, IonCardContent,
    IonButton, IonLabel, IonItem, IonList, IonChip, IonSpinner
  ]
})
export class BtSettingsPage implements OnInit, OnDestroy {

  isConnected$ = this.bt.isConnected$;

  pairedDevices$ = this.bt.pairedDevices$;
  unpairedDevices$ = this.bt.unpairedDevices$;

  left$ = this.bt.distanceLeft$;
  right$ = this.bt.distanceRight$;

  relayLeft$ = this.bt.relayLeft$;
  relayRight$ = this.bt.relayRight$;

  isScanning = false;

  constructor(
    public bt: BluetoothService,
    private router: Router
  ) {}

  ngOnInit() {
    console.log('[BT-SETTINGS] init');
    this.bt.loadPairedDevices().catch(err => console.error(err));
  }

  ngOnDestroy() {
    console.log('[BT-SETTINGS] destroy');
  }

  async connectTo(device: BluetoothDevice) {
    try {
      console.log("[BT] Intentando conectar a:", device.address);
      await this.bt.connect(device.address);
    } catch (err) {
      console.error('Error al conectar', err);
    }
  }

  async scan() {
    this.isScanning = true;
    try {
      await this.bt.scanForUnpaired();
    } catch (e) {
      console.error("Scan error:", e);
    } finally {
      this.isScanning = false;
    }
  }

  async tryConnect(device: BluetoothDevice) {
    console.log("Intentando conectar:", device);
    await this.connectTo(device);
  }

  async disconnect() {
    await this.bt.disconnect();
  }

  requestStatus() {
    this.bt.requestStatus();
  }
}
