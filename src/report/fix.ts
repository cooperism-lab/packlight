import type { BudgetObservation, Inventory, Item, Kind } from '../core/types.js';
import { MIN_DAYS, MIN_SESSIONS, simulateListing, type ListingEntry, type Suggestion } from './suggest.js';

/** The listing for the scan's scope: its own project's newest, else the newest anywhere. */
export function newestBudget(inv: Inventory): BudgetObservation | undefined {
  const own = inv.projectScope !== 'global' ? inv.budget[inv.projectScope] : undefined;
  return own ?? Object.values(inv.budget).sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')).at(-1);
}

export interface ListingProjection { chars: number; described: number; dropped: number }

export interface FixPlan {
  /** Archive targets, plugin-level (CEO O3). */
  ids: string[];
  /** Targets by kind, and everything they turn off counting plugin parts. */
  byKind: Partial<Record<Kind, number>>;
  turnsOff: number;
  listing: { before: ListingProjection; after: ListingProjection; observedAt: string | null } | null;
  /** Skills that get their description back in the listing. */
  descriptionsBack: number;
  /** Fewer characters in every session: the listing, agent descriptions and session-start hook text. */
  sessionCharsSaved: number;
  /** Unused items packlight may not remove; the totals count them on top of the archive (cumulative). */
  byHand: { items: ByHand[]; descriptionsBack: number; sessionCharsSaved: number } | null;
}

/** The skill listing as entries, in the order Claude Code logged it, without the items in `gone`. */
export function listingEntries(inv: Inventory, b: BudgetObservation, gone: Set<string> = new Set()): ListingEntry[] {
  const byKey = new Map<string, Item>();
  for (const i of inv.items) for (const k of i.logKeys) if (!byKey.has(k)) byKey.set(k, i);
  const priority = new Set(inv.listingPriority ?? []);
  const lines = b.entries ?? [...b.withDescription.map(name => ({ name, chars: 0, described: true })), ...b.dropped.map(name => ({ name, chars: 0, described: false }))];
  const out: ListingEntry[] = [];
  for (const l of lines) {
    const it = byKey.get(l.name);
    if (it && gone.has(it.id)) continue;
    const nameChars = l.name.length + 3;
    const full = l.described && l.chars ? l.chars : it?.standingChars ? it.standingChars : l.chars || nameChars;
    // Skills Claude Code counts as used, and its own bundled skills (no file packlight knows), go first.
    out.push({ name: l.name, nameChars, fullChars: Math.max(full, nameChars), priority: priority.has(l.name) || !it });
  }
  return out;
}

export interface ByHand { id: string; name: string; kind: Kind; where: string; turnsOff: number }

/**
 * One-click fix: archive every suggested item (plugin-level), and say what it buys. Suggestions already exclude
 * anything used, kept, too new or ambiguous. Items only removable by hand (claude.ai synced skills, the Claude
 * app's own plugins) that pass the same rules are listed separately with what removing them too would buy.
 */
export function fixPlan(inv: Inventory, sug: Map<string, Suggestion>, keptIds: Set<string> = new Set()): FixPlan {
  const plugins = new Map(inv.items.filter(i => i.kind === 'plugin').map(p => [p.plugin, p]));
  const pluginOf = (i: Item): Item => (i.plugin && i.kind !== 'plugin' ? plugins.get(i.plugin) ?? i : i);
  const partsOf = (p: Item): Item[] => inv.items.filter(m => m.plugin === p.plugin && m.kind !== 'plugin');
  const inScope = (i: Item): boolean => inv.projectScope === 'global' || i.projectRoot === null || i.projectRoot === inv.projectScope;

  const targets = new Map<string, Item>();
  for (const i of inv.items) {
    if (i.kind === 'instructions' || !inScope(i) || !sug.get(i.id)?.suggested) continue;
    const t = pluginOf(i);
    if (sug.get(t.id)?.suggested) targets.set(t.id, t);
  }

  // By hand: the suggestion rules minus the removal method. A plugin qualifies only when no part was used or kept.
  const qualifiesByHand = (i: Item): boolean => {
    const s = sug.get(i.id);
    return !!s && s.reason === 'manual' && !i.removal.suite && i.enabled && !keptIds.has(i.id) && !i.usage.total && !i.usage.ambiguous && !i.usage.uncertain
      && s.windowSessions >= MIN_SESSIONS && s.windowDays >= MIN_DAYS && !s.unreadableLines;
  };
  const hand = new Map<string, Item>();
  for (const i of inv.items) {
    if (i.kind === 'instructions' || !inScope(i) || targets.has(i.id)) continue;
    const t = pluginOf(i);
    if (hand.has(t.id) || targets.has(t.id)) continue;
    if (t.kind === 'plugin' ? qualifiesByHand(t) && partsOf(t).every(m => !m.usage.total && !keptIds.has(m.id)) : t === i && qualifiesByHand(i)) hand.set(t.id, t);
  }

  const expand = (set: Iterable<Item>): Set<string> => {
    const gone = new Set<string>();
    for (const t of set) { gone.add(t.id); if (t.kind === 'plugin') for (const m of partsOf(t)) gone.add(m.id); }
    return gone;
  };
  const gone = expand(targets.values());
  const goneWithHand = expand([...targets.values(), ...hand.values()]);

  const b = newestBudget(inv);
  const cap = b && b.dropped.length ? b.listingChars : Number.MAX_SAFE_INTEGER;
  const before = b ? simulateListing(listingEntries(inv, b), cap) : null;
  const outcome = (g: Set<string>): { listing: ListingProjection | null; descriptionsBack: number; sessionCharsSaved: number } => {
    let listing: ListingProjection | null = null;
    let descriptionsBack = 0;
    if (b && before) {
      const staying = listingEntries(inv, b, g);
      const { describedNames, ...after } = simulateListing(staying, cap);
      void describedNames;
      // Archived skills that were name-only also leave the dropped count; only skills that stay can "come back".
      const had = new Set(before.describedNames);
      descriptionsBack = Math.max(0, staying.filter(e => !had.has(e.name)).length - after.dropped);
      listing = after;
    }
    const goneItems = inv.items.filter(i => g.has(i.id));
    const agentChars = goneItems.filter(i => i.kind === 'agent').reduce((n, i) => n + i.standingChars, 0);
    const hookChars = goneItems.filter(i => i.kind === 'hook' && i.hook?.event === 'SessionStart' && i.usage.hook?.firings)
      .reduce((n, i) => n + i.usage.hook!.injectedChars / i.usage.hook!.firings, 0);
    return { listing, descriptionsBack, sessionCharsSaved: Math.round((listing && before ? before.chars - listing.chars : 0) + agentChars + hookChars) };
  };

  const auto = outcome(gone);
  const withHand = hand.size ? outcome(goneWithHand) : null;
  const byKind: Partial<Record<Kind, number>> = {};
  for (const t of targets.values()) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
  const strip = (p: ReturnType<typeof simulateListing>): ListingProjection => ({ chars: p.chars, described: p.described, dropped: p.dropped });
  return {
    ids: [...targets.keys()],
    byKind,
    turnsOff: gone.size,
    listing: before && auto.listing ? { before: strip(before), after: auto.listing, observedAt: b!.timestamp } : null,
    descriptionsBack: auto.descriptionsBack,
    sessionCharsSaved: auto.sessionCharsSaved,
    byHand: withHand ? {
      items: [...hand.values()].map(t => ({ id: t.id, name: t.name, kind: t.kind, where: t.removal.where ?? '', turnsOff: t.kind === 'plugin' ? partsOf(t).length : 1 })),
      descriptionsBack: withHand.descriptionsBack,
      sessionCharsSaved: withHand.sessionCharsSaved,
    } : null,
  };
}
