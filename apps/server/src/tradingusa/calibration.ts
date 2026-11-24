/**
 * Server side of the outcome-calibration layer: reads closed trades +
 * their signals, fits the pure tucore model, persists one row so the scan
 * can stamp every new signal with what the book's OWN history says that
 * conviction and expected return are worth.
 *
 * SHADOW contract: nothing here gates, filters or sizes a trade — the fitted
 * values ride along in `signals.audit_json.calibration` and are served by
 * GET /api/tradingusa/calibration. Promoting any of it into a live decision
 * needs an explicit go first.
 */
import type { DatabaseSync } from 'node:sqlite';
import { fitCalibration } from '@promptslim/tucore';
import type { Calibration, CalibrationSample } from '@promptslim/tucore';

const KEY = 'global';

export function calibrationSamples(db: DatabaseSync): CalibrationSample[] {
  return db
    .prepare(
      `SELECT s.confidence AS confidence,
              t.predicted_return AS predictedReturn,
              t.actual_return AS actualReturn,
              t.exit_ts AS ts
         FROM paper_trades t
         JOIN signals s ON s.id = t.signal_id
        WHERE t.status = 'CLOSED' AND t.exit_ts IS NOT NULL
          AND t.actual_return IS NOT NULL AND s.confidence IS NOT NULL`,
    )
    .all() as unknown as CalibrationSample[];
}

export function computeCalibration(db: DatabaseSync, now = Date.now()): Calibration {
  return fitCalibration(calibrationSamples(db), { now });
}

/** The row the scan reads. null = never fitted (fresh book). */
export function loadCalibration(db: DatabaseSync): Calibration | null {
  const row = db.prepare('SELECT payload_json, updated_at FROM calibration_state WHERE key = ?').get(KEY) as
    | { payload_json: string; updated_at: number }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as Calibration;
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.buckets) ? parsed : null;
  } catch {
    return null;
  }
}

export function recomputeCalibration(db: DatabaseSync, now = Date.now()): { samples: number; sufficient: boolean } {
  const cal = computeCalibration(db, now);
  db.prepare(
    `INSERT INTO calibration_state (key, payload_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(cal), now);
  return { samples: cal.n, sufficient: cal.sufficient };
}
