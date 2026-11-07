/**
 * Entry/stop geometry guard — correction phase, approved item 1.
 *
 * Long entries must clear the stop/invalidation level by a configurable
 * safety buffer BEFORE an order exists, and again at fill time. The guard
 * never clamps a price, never widens a stop, never touches a live order:
 * a structurally invalid entry is simply rejected with a reason code, and
 * an unexpected fill beyond invalidation keeps following the existing
 * protective risk procedure (monitorPositions -> checkExit -> STOP_REACHED).
 *
 * The book is long-only today: SELL never opens a position, so the
 * directional rule for shorts is expressed as UNSUPPORTED_SIDE rather than
 * silently reusing the long logic with an inverted comparison.
 */

export type EntryRejectCode =
  | 'BAD_GEOMETRY'
  | 'ENTRY_EXEC_BELOW_STOP'
  | 'ENTRY_BAND_OVERLAP_STOP'
  | 'UNSUPPORTED_SIDE';

export interface EntryGeometryInput {
  side: 'BUY' | 'SELL';
  /** price this order would actually execute at (market ref now, fill later) */
  executablePrice: number;
  /** strategy entry-band lower edge; checked only when provided */
  bandLow?: number | null;
  invalidation: number;
  /** safety buffer as a fraction (0.001 = 10bps above the stop) */
  bufferPct: number;
}

export interface EntryGeometryVerdict {
  ok: boolean;
  code?: EntryRejectCode;
  /** price the executable entry must be >= to pass */
  requiredMin?: number;
  detail?: string;
}

export function entryStopFloor(invalidation: number, bufferPct: number): number {
  return invalidation * (1 + bufferPct);
}

/** Blocking structural check: executable entry must clear stop + buffer. */
export function validateEntryGeometry(req: EntryGeometryInput): EntryGeometryVerdict {
  const { side, executablePrice, invalidation, bufferPct } = req;
  if (side !== 'BUY') {
    return { ok: false, code: 'UNSUPPORTED_SIDE', detail: 'this book is long-only; SHORT entries are not supported' };
  }
  if (
    !Number.isFinite(executablePrice) || executablePrice <= 0 ||
    !Number.isFinite(invalidation) || invalidation <= 0 ||
    !Number.isFinite(bufferPct) || bufferPct < 0
  ) {
    return { ok: false, code: 'BAD_GEOMETRY', detail: 'non-finite or non-positive entry/stop/buffer' };
  }
  const requiredMin = entryStopFloor(invalidation, bufferPct);
  if (executablePrice < requiredMin) {
    return {
      ok: false,
      code: 'ENTRY_EXEC_BELOW_STOP',
      requiredMin,
      detail: `executable ${executablePrice} < stop ${invalidation} + ${Math.round(bufferPct * 10_000)}bps (min ${requiredMin})`,
    };
  }
  if (req.bandLow != null && Number.isFinite(req.bandLow) && req.bandLow < requiredMin) {
    return {
      ok: false,
      code: 'ENTRY_BAND_OVERLAP_STOP',
      requiredMin,
      detail: `entry band low ${req.bandLow} < stop floor ${requiredMin} — the strategy would accept a fill inside its own invalidation`,
    };
  }
  return { ok: true };
}

/** Advisory only: does the strategy's entry band dip into invalidation?
 *  Recorded at scan time so the strategy-geometry fix stays visible; it does
 *  not block orders — the executable-price check above (scan + fill) does. */
export function entryBandOverlapsStop(bandLow: number | null | undefined, invalidation: number, bufferPct: number): boolean {
  if (bandLow == null || !Number.isFinite(bandLow)) return false;
  if (!Number.isFinite(invalidation) || invalidation <= 0 || !Number.isFinite(bufferPct) || bufferPct < 0) return false;
  return bandLow < entryStopFloor(invalidation, bufferPct);
}
