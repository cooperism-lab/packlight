// The inventory contract (eng X6). Every later part of packlight reads this shape;
// change it only with a schemaVersion bump.

export const SCHEMA_VERSION = 1;

export type Agent = 'claude-code';
export type Kind = 'skill' | 'command' | 'agent' | 'hook' | 'plugin' | 'mcp' | 'instructions';
export type RemovalMethod = 'move' | 'hook-extract' | 'mcp-extract' | 'plugin-disable' | 'manual';
export type DeclScope = 'user' | 'local' | 'project' | 'project-local' | 'plugin' | 'app';

/** One place an item is declared (eng X2): an item can be enabled in several settings files at once. */
export interface Declaration {
  file: string;
  scope: DeclScope;
  /** JSON pointer inside `file` for settings-file declarations (hooks, MCP servers, plugin flags). */
  pointer?: string;
  enabled?: boolean;
}

export interface HookUsage {
  firings: number;
  /** Characters the hook added to the context: linked additional-context text, else hook output. */
  injectedChars: number;
  avgDurationMs: number;
  p95DurationMs: number;
  /** Injected text could not be split between several hooks that fired on the same tool call. */
  injectionShared: boolean;
}

export interface Usage {
  total: number;
  last30: number;
  lastUsed: string | null;
  /** Uses per project root (or "global" when the line had no project). */
  byProject: Record<string, { total: number; lastUsed: string | null }>;
  /** Another item shares the name or command the logs record, so the count cannot be split (CEO O2). */
  ambiguous: boolean;
  /** The logs held lines packlight could not recognise, so a zero may be wrong (eng A2). */
  uncertain: boolean;
  hook?: HookUsage;
}

export interface Item {
  id: string;
  agent: Agent;
  kind: Kind;
  name: string;
  /** Human source label: "personal", "project", "plugin:<name>", "claude.ai synced", "user config", … */
  source: string;
  /** Absolute path of the item on disk, or null for items that only live in an app or web UI. */
  path: string | null;
  /** Project root for project-scoped items; null for items that load in every project. */
  projectRoot: string | null;
  enabled: boolean;
  description: string;
  /** sha256 of name + description (drives incremental rating). */
  descHash: string;
  /** Characters this item puts into every session's context (0 for hooks and on-demand items). */
  standingChars: number;
  /** Content fingerprint checked again before apply (eng X1). */
  targetFingerprint: string;
  /** Earliest known install time (design-delta DE5); null when unknown. */
  firstSeen: string | null;
  firstSeenSource: 'birthtime' | 'mtime' | 'installedAt' | null;
  /** Keys the session logs use for this item (skill name, "plugin:skill", subagent type, MCP server …). */
  logKeys: string[];
  /** Parent plugin key ("name@marketplace") for plugin-bundled items; plugins are the removal unit (CEO O3). */
  plugin?: string;
  hook?: { event: string; matcher: string | null; command: string };
  members?: Partial<Record<Kind, number>>;
  declarations: Declaration[];
  /** suite: a folder other skills depend on (gstack); never moved, never offered by the fix. */
  removal: { method: RemovalMethod; where?: string; suite?: true };
  usage: Usage;
}

export interface SessionRecord {
  id: string;
  file: string;
  projectRoot: string | null;
  start: string | null;
  end: string | null;
  lines: number;
  unknownShapeLines: number;
  unreadableLines: number;
  versions: string[];
}

/** One skill listing as Claude Code logged it: which skills kept their description (eng X8). */
export interface BudgetObservation {
  sessionId: string;
  timestamp: string | null;
  version: string | null;
  projectRoot: string | null;
  skillCount: number;
  listingChars: number;
  withDescription: string[];
  dropped: string[];
  /** Every line in listing order, with its size as logged (multi-line descriptions included). */
  entries?: ListingLine[];
}

export interface ListingLine { name: string; chars: number; described: boolean }

/** One server's share of a session's tool list: its tool-name lines and its instructions block. */
export interface ToolServerLoad { tools: number; chars: number; instructionChars: number; label?: string; /** A few tool names, to tell id-named connectors apart. */ sample?: string[] }

/**
 * The tool list one session was given: Claude Code names every deferred tool at session start, and MCP servers
 * may add instructions. Logged as deltas; this is their sum for the session.
 */
export interface ToolListing {
  sessionId: string;
  timestamp: string | null;
  version: string | null;
  projectRoot: string | null;
  /** By server key: the part of "mcp__<key>__<tool>", or the instructions' server name in the same form. */
  servers: Record<string, ToolServerLoad>;
  /** Claude Code's own deferred tools (no "mcp__" prefix). */
  builtIn: { tools: number; chars: number };
}

export interface Inventory {
  schemaVersion: number;
  scanId: string;
  agent: Agent;
  createdAt: string;
  home: string;
  /** "global", or the project root the scan was run for (eng X6, CEO O1). */
  projectScope: string;
  window: { from: string | null; to: string };
  sessionsInWindow: number;
  linesTotal: number;
  linesUnknownShape: number;
  linesUnreadable: number;
  claudeCodeVersions: string[];
  coverage: { uncertain: boolean; reasons: string[] };
  projects: { root: string; sessions: number; exists: boolean }[];
  sessions: SessionRecord[];
  /** Newest initial skill listing per project root ("global" key for no project). */
  budget: Record<string, BudgetObservation>;
  /** Newest tool list per project root ("global" key for no project). */
  toolListing?: Record<string, ToolListing>;
  /** Skills Claude Code itself counts as used (~/.claude.json skillUsage): it keeps their descriptions first. */
  listingPriority?: string[];
  /** Hook context the logs recorded but no hook line could be matched to. */
  unattributedHookChars: number;
  items: Item[];
}
