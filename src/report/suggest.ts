import type { Inventory, Item } from '../core/types.js';

/** Thresholds printed beside the suggestion button (design DR6). */
export const MIN_SESSIONS = 20;
export const MIN_DAYS = 14;
const DAY = 86_400_000;

export type NotSuggested =
  | 'used' | 'too-new' | 'too-few-sessions' | 'ambiguous' | 'uncertain' | 'parse-gaps'
  | 'manual' | 'kept' | 'off' | 'plugin-in-use' | 'not-removable';

export interface Suggestion {
  suggested: boolean;
  reason?: NotSuggested;
  /** Sessions and days the item could have been used in (design-delta DE5). */
  windowSessions: number;
  windowDays: number;
  /** Unreadable log lines inside the item's window (DE6). */
  unreadableLines: number;
}

/**
 * Decides, per item, whether the report may suggest archiving it. Usage for global items is counted across
 * all projects (DE1); the window starts when the item was first seen (DE5); unreadable lines inside the window
 * block a suggestion (DE6); a plugin child is suggested only when its whole plugin could go (DE7).
 */
export function suggestions(inv: Inventory, keptIds: Set<string>): Map<string, Suggestion> {
  const scanTime = Date.parse(inv.window.to);
  const windowFrom = inv.window.from ? Date.parse(inv.window.from) : scanTime;
  const sessions = inv.sessions.filter(s => s.start);

  const own = (it: Item): Suggestion => {
    const from = Math.max(windowFrom, it.firstSeen ? Date.parse(it.firstSeen) : windowFrom);
    const inWindow = sessions.filter(s => Date.parse(s.start!) >= from && (it.projectRoot === null || s.projectRoot === it.projectRoot));
    const base: Suggestion = {
      suggested: false,
      windowSessions: inWindow.length,
      windowDays: Math.floor((scanTime - from) / DAY),
      unreadableLines: inWindow.reduce((n, s) => n + s.unreadableLines, 0),
    };
    const no = (reason: NotSuggested): Suggestion => ({ ...base, reason });
    if (it.kind === 'instructions') return no('not-removable');
    if (it.removal.method === 'manual') return no('manual');
    if (it.name === 'packlight' || it.name.endsWith(':packlight')) return no('not-removable');
    if (!it.enabled) return no('off');
    if (keptIds.has(it.id)) return no('kept');
    if (it.usage.ambiguous) return no('ambiguous');
    if (it.usage.uncertain) return no('uncertain');
    if (it.usage.total > 0) return no('used');
    if (base.windowDays < MIN_DAYS) return no('too-new');
    if (base.windowSessions < MIN_SESSIONS) return no('too-few-sessions');
    if (base.unreadableLines > 0) return no('parse-gaps');
    return { ...base, suggested: true };
  };

  const result = new Map<string, Suggestion>();
  for (const it of inv.items) result.set(it.id, own(it));

  // Plugins are judged as a whole (DE7): every part must be eligible on its own, and nothing in it kept.
  for (const plugin of inv.items.filter(i => i.kind === 'plugin')) {
    const parts = inv.items.filter(i => i.plugin === plugin.plugin && i.kind !== 'plugin');
    const self = result.get(plugin.id)!;
    const partBlocked = parts.find(p => !result.get(p.id)!.suggested);
    const whole: Suggestion = !self.suggested ? self
      : partBlocked ? { ...self, suggested: false, reason: result.get(partBlocked.id)!.reason === 'used' ? 'plugin-in-use' : result.get(partBlocked.id)!.reason }
      : self;
    result.set(plugin.id, whole);
    for (const p of parts) {
      const mine = result.get(p.id)!;
      result.set(p.id, whole.suggested ? mine : { ...mine, suggested: false, reason: mine.suggested ? (whole.reason === 'used' ? 'plugin-in-use' : whole.reason) : mine.reason });
    }
  }
  return result;
}

/** One line in the skill listing, for the budget projection. */
export interface ListingEntry { name: string; lineChars: number; nameChars: number; uses: number }

/**
 * Projects how many skills would lose their description once some are archived: Claude Code fills a fixed
 * budget with descriptions, most used first, and lists the rest by name only. The budget is the listing size
 * Claude Code logged. A projection, always labelled as one.
 */
export function projectDropped(entries: ListingEntry[], budgetChars: number): number {
  const sorted = [...entries].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  let used = sorted.reduce((n, e) => n + e.nameChars, 0);
  let withDesc = 0;
  for (const e of sorted) {
    const extra = e.lineChars - e.nameChars;
    if (used + extra > budgetChars) break;
    used += extra;
    withDesc++;
  }
  return sorted.length - withDesc;
}
