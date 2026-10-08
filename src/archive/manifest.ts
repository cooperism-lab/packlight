import { randomBytes } from 'node:crypto';
import type { Kind, RemovalMethod } from '../core/types.js';

/** One archive operation: one declaration of one item (eng X2, X5). Readers must accept older versions. */
export interface Manifest {
  manifestVersion: 1;
  opId: string;
  itemId: string;
  itemName: string;
  kind: Kind;
  agent: string;
  method: RemovalMethod;
  scanId: string;
  archivedAt: string;
  /** archived: packlight holds it; restored: put back; waiting: removable only by hand. */
  status: 'archived' | 'restored' | 'waiting';
  restoredAt?: string;
  note?: string;

  // move
  originalPath?: string;
  payloadPath?: string;
  isSymlink?: boolean;
  symlinkTarget?: string;
  /** Fingerprint of what was moved, checked again before restore. */
  fingerprint?: string;

  // hook-extract, mcp-extract, plugin-disable
  settingsFile?: string;
  jsonPointer?: string;
  /** The removed or changed JSON value, printed when a restore has to be done by hand (D12). */
  fragment?: unknown;
  /** The whole settings file as it was, base64; null when the file did not exist. */
  originalFileBase64?: string | null;
  fileHashBefore?: string | null;
  fileHashAfter?: string | null;
  plugin?: { key: string; wasEnabled: boolean | null };

  // manual
  manualSteps?: string;
}

/** Operation ids never repeat: UTC time plus 6 random hex (eng X5). They sort by time. */
let lastMs = 0;
export function newOpId(now = new Date()): string {
  // Strictly increasing even within one millisecond, so "newest first" is a total order (several edits of one file).
  const ms = Math.max(now.getTime(), lastMs + 1);
  lastMs = ms;
  return `${new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z')}-${randomBytes(3).toString('hex')}`;
}
