import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonHeader, IonToolbar, IonTitle,
  IonContent, IonButtons, IonBackButton,
  IonItem, IonLabel, IonInput, IonList, IonButton, IonNote
} from '@ionic/angular/standalone';

import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BluetoothService } from '../services/bluetooth.service';

@Component({
  selector: 'app-auto-config',
  templateUrl: './auto-config.page.html',
  styleUrls: ['./auto-config.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader, IonToolbar, IonTitle,
    IonContent, IonButtons, IonBackButton,
    IonItem, IonLabel, IonInput, IonList, IonButton, IonNote
  ]
})
export class AutoConfigPage implements OnInit {

  thresholdCm = 30;
  hysteresisCm = 10;
  holdTimeMs = 300;

  // ⭐ NUEVO PARAMETRO CONFIGURABLE
  maxValidDistanceCm = 250;

  constructor(
    private btService: BluetoothService,
    private router: Router
  ) {}

  ngOnInit() {
    // Cargar valores actuales desde el servicio
    this.btService.thresholdCm$.subscribe(v => this.thresholdCm = v);
    this.btService.hysteresisCm$.subscribe(v => this.hysteresisCm = v);
    this.btService.holdTimeMs$.subscribe(v => this.holdTimeMs = v);

    // ⭐ NEW: distancia máxima válida
    this.btService.maxValidDistanceCm$.subscribe(v => {
      this.maxValidDistanceCm = v ?? 250;
    });
  }

  // ============================
  // VALIDADORES Y SETTERS
  // ============================

  onThresholdChange() {
    if (this.thresholdCm < 5)  this.thresholdCm = 5;
    if (this.thresholdCm > 300) this.thresholdCm = 300;
    this.btService.setThresholdCm(this.thresholdCm);
  }

  onHysteresisChange() {
    if (this.hysteresisCm < 0)  this.hysteresisCm = 0;
    if (this.hysteresisCm > 200) this.hysteresisCm = 200;
    this.btService.setHysteresisCm(this.hysteresisCm);
  }

  onHoldTimeChange() {
    if (this.holdTimeMs < 0) this.holdTimeMs = 0;
    if (this.holdTimeMs > 5000) this.holdTimeMs = 5000;
    this.btService.setHoldTimeMs(this.holdTimeMs);
  }

  // ⭐ NEW
  onMaxValidDistanceChange() {
    if (this.maxValidDistanceCm < 50)  this.maxValidDistanceCm = 50;
    if (this.maxValidDistanceCm > 400) this.maxValidDistanceCm = 400;
    this.btService.setMaxValidDistanceCm(this.maxValidDistanceCm);
  }

  goBack() {
    this.router.navigate(['/distance-view']);
  }
}


