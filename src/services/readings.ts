import { newId } from '../core/id.js';
import { alerts, audits, log, readings } from '../domain/state.js';
import type { Alert, Reading, Sensor } from '../domain/types.js';

export type ReadingConflict = { field: 'value' | 'unit' | 'quality'; existing: number | string; attempted: number | string };

export type IngestOutcome =
  | { outcome: 'accepted'; idempotent: false; reading: Reading; alerts: Alert[] }
  | { outcome: 'duplicate'; idempotent: true; reading: Reading; alerts: Alert[] }
  | { outcome: 'conflict'; idempotent: false; existing: Reading; attempted: Reading; conflicts: ReadingConflict[] };

function findReading(sensorId: string, timeMs: number): Reading | undefined {
  return readings.find((x) => x.sensorId === sensorId && x.timeMs === timeMs);
}

function alertsFor(sensorId: string, timeMs: number): Alert[] {
  return alerts.filter((x) => x.sensorId === sensorId && x.timeMs === timeMs);
}

function diffReadings(existing: Reading, attempted: Reading): ReadingConflict[] {
  const conflicts: ReadingConflict[] = [];
  if (existing.value !== attempted.value) conflicts.push({ field: 'value', existing: existing.value, attempted: attempted.value });
  if (existing.unit !== attempted.unit) conflicts.push({ field: 'unit', existing: existing.unit, attempted: attempted.unit });
  if (existing.quality !== attempted.quality) conflicts.push({ field: 'quality', existing: existing.quality, attempted: attempted.quality });
  return conflicts;
}

function raiseAlert(sensor: Sensor, reading: Reading): Alert | undefined {
  const abs = Math.abs(reading.value);
  if (abs < sensor.limits.warning) return undefined;
  const critical = abs >= sensor.limits.critical;
  const alert: Alert = {
    id: newId(),
    sensorId: sensor.id,
    elementId: sensor.elementId,
    timeMs: reading.timeMs,
    severity: critical ? 'critical' : 'warning',
    value: reading.value,
    threshold: critical ? sensor.limits.critical : sensor.limits.warning,
    status: 'open',
    reason: 'threshold-exceeded',
  };
  alerts.push(alert);
  return alert;
}

/**
 * Whether this exact conflicting payload was already rejected for the same sample point.
 * The audit log is the single source of truth, so retrying a rejected request stays
 * idempotent and does not flood the audit trail with duplicate entries.
 */
function conflictAlreadyAudited(sensorId: string, attempted: Reading): boolean {
  return audits.some(
    (a) =>
      a.action === 'reading.conflict-rejected' &&
      a.entity === sensorId &&
      a.payload?.attempted?.timeMs === attempted.timeMs &&
      a.payload?.attempted?.value === attempted.value &&
      a.payload?.attempted?.unit === attempted.unit &&
      a.payload?.attempted?.quality === attempted.quality,
  );
}

/**
 * Idempotent ingest for one sensor sample point (sensorId + timeMs).
 *
 * - identical retry (same value/unit/quality): replayed with no side effects — no
 *   duplicate reading, alert, health-score deduction or audit record.
 * - same sample point, different value/unit/quality: explicit conflict; the stored
 *   reading is never overwritten and nothing is appended.
 */
export function ingestReading(sensor: Sensor, attempted: Reading): IngestOutcome {
  const existing = findReading(attempted.sensorId, attempted.timeMs);

  if (existing) {
    if (existing.value === attempted.value && existing.unit === attempted.unit && existing.quality === attempted.quality) {
      return { outcome: 'duplicate', idempotent: true, reading: existing, alerts: alertsFor(existing.sensorId, existing.timeMs) };
    }
    const conflicts = diffReadings(existing, attempted);
    if (!conflictAlreadyAudited(sensor.id, attempted)) {
      log('reading.conflict-rejected', sensor.id, { existing, attempted, conflicts });
    }
    return { outcome: 'conflict', idempotent: false, existing, attempted, conflicts };
  }

  readings.push(attempted);
  raiseAlert(sensor, attempted);
  log('reading.ingest', sensor.id, attempted);
  return { outcome: 'accepted', idempotent: false, reading: attempted, alerts: alertsFor(attempted.sensorId, attempted.timeMs) };
}
