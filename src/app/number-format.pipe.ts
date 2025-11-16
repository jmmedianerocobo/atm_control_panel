import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'numberFormat',
  standalone: true,
})
export class NumberFormatPipe implements PipeTransform {
  /**
   * Transforma un número (segundos) en un formato de tiempo (mm:ss) o lo devuelve como string.
   * @param value El número de segundos a formatear.
   * @param format 'time' para formato mm:ss.
   */
  transform(value: number | null, format: 'time'): string {
    if (value === null || value === undefined) return '00:00';

    if (format === 'time') {
      const totalSeconds = Math.floor(value);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;

      // Asegura que los minutos y segundos tengan al menos dos dígitos
      const paddedMinutes = String(minutes).padStart(2, '0');
      const paddedSeconds = String(seconds).padStart(2, '0');

      return `${paddedMinutes}:${paddedSeconds}`;
    }

    return String(value);
  }
}