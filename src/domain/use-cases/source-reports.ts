import type { PeerSource } from '../ports/index.js';
import { ConfigurationError, type DomainError } from '../errors/index.js';

/** Per-source bookkeeping while a quorum run is in flight; frozen into
 * QuorumSourceReport when the run finalizes. */
export interface MutableReport {
  name: string;
  model: string;
  status: 'ok' | 'error' | 'unavailable';
  weight: number;
  agreement: number | null;
  error?: string | undefined;
}

/** A source starts non-ok and only earns "ok" by settling successfully. The
 * seeded reason matters: a source that never settles at all (deadline hit,
 * early abort once quorum is reached) would otherwise report a bare "error"
 * status, which the caller — who sees only this envelope — cannot diagnose. */
export function seedReport(source: PeerSource): MutableReport {
  return {
    name: source.name,
    model: source.model,
    status: source.available ? 'error' : 'unavailable',
    weight: source.weight,
    agreement: null,
    error: source.available
      ? 'No response recorded before the run ended'
      : 'Credential not resolvable; source skipped',
  };
}

export function markOk(report: MutableReport): void {
  report.status = 'ok';
  delete report.error;
}

export function markFailed(report: MutableReport, error: DomainError): void {
  report.status = error instanceof ConfigurationError ? 'unavailable' : 'error';
  report.error = error.message;
}
