/** SPEC §6.2's uses vocabulary, which is closed: a declaration whose uses holds anything else
 *  is invalid. */
export const CAPABILITY_PATHS = [
  'pushEvents',
  'tools',
  'modelInfo',
  'inferenceRequest',
  'inferenceRequest.streaming',
  'inferenceLifecycle',
  'contextHooks.beforeInference.observe',
  'contextHooks.beforeInference.inject.system',
  'contextHooks.beforeInference.inject.beforeUser',
  'contextHooks.beforeInference.inject.afterUser',
  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'channels.streaming',
  'channels.acknowledge',
  'channels.typing',
] as const;

export type CapabilityPath = (typeof CAPABILITY_PATHS)[number];

const CAPABILITY_PATH_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_PATHS);

export function isCapabilityPath(value: unknown): value is CapabilityPath {
  return typeof value === 'string' && CAPABILITY_PATH_SET.has(value);
}

/** SPEC §6.1, §6.2 and App. B.2's feature-set declaration, with rollback from §8.1. */
export interface FeatureSetDeclaration05 {
  description: string;
  uses: CapabilityPath[];
  rollback?: boolean;
  /** RFC-001 §5: the tags this feature set's events carry, and how it suggests treating them (advisory; a host applies a suggestion only on acceptance, §5.2). */
  tagOntology?: TagOntology;
}

/** The RFC-001 §5.1 descriptor shape, a superset of what this server declares (it leaves out §5.1's `implies`, `stability` and `keyed`). `rationale` is the proposed §5.1 addition: what the rule is for, and what declining it costs. */
export interface TagOntology {
  coreTags?: string[];
  tags?: Record<string, { desc: string; facet?: string; suggestedTreatment?: TreatmentBehavior; rationale?: string }>;
  suggestedTreatment?: Array<{ tagsAny?: string[]; tagsAll?: string[]; tagsNone?: string[]; behavior: TreatmentBehavior; rationale?: string }>;
  open?: boolean;
}
export type TreatmentBehavior = 'immediate' | 'mute' | { debounce: number } | { throttle: { perMs: number } };

export type FeatureSetMap = Record<string, FeatureSetDeclaration05>;

export type FeatureSetWireEntry = FeatureSetDeclaration05 & { name: string };

export interface FeatureSetsUpdateParams05 {
  /** §5.4: the sole normative allowlist. Absence of a path is denial. */
  effectiveCapabilities?: unknown;
  /** §5.4: derived diagnostic data only; MUST NOT authorize anything. */
  deniedCapabilities?: unknown;
  enabled?: unknown;
  disabled?: unknown;
}

/** SPEC §5.1: advertisement mirrors the capability paths, and false or absence means none.
 *  tools is MCP's own capabilities.tools, not repeated in the MCPL block. */
export interface McplServerCapabilities05 {
  version: string;
  revision?: string;
  pushEvents?: boolean;
  featureSets?: FeatureSetWireEntry[];
}

export interface InitializeCapabilities05 {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  experimental?: { mcpl?: McplServerCapabilities05 };
}

export interface McplInitializeResult05 {
  protocolVersion: string;
  capabilities: InitializeCapabilities05;
  serverInfo: { name: string; version: string };
}

export interface UnavailableFeature {
  featureSet: string;
  missingCapabilities: string[];
  effect: 'disabled';
}

/** SPEC §6.7: testimony about consequences, never a claim of entitlement. */
export interface AcceptedReceipt {
  accepted: true;
  /** SPEC §6.7: absent when nothing degraded. */
  mode?: 'degraded';
  unavailableFeatures: UnavailableFeature[];
  notes?: string[];
}

export interface RefusedReceipt {
  accepted: false;
  fallback: 'mcp-only' | 'close';
  missingCapabilities?: string[];
  reason?: string;
}

export type DegradationReceipt = AcceptedReceipt | RefusedReceipt;

export interface Grant {
  readonly patterns: readonly string[];
  readonly paths: ReadonlySet<CapabilityPath>;
  readonly denied: readonly string[];
  readonly disabled: readonly string[];
  readonly enabled: readonly string[] | null;
}

export const EMPTY_GRANT: Grant = {
  patterns: [],
  paths: new Set<CapabilityPath>(),
  denied: [],
  disabled: [],
  enabled: null,
};

export type PolicyParse =
  | { ok: true; grant: Grant; hadEffectiveCapabilities: boolean }
  | { ok: false; error: string };

function stringArray(value: unknown, field: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: `"${field}" must be an array of strings` };
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, error: `"${field}" must contain only strings` };
  }
  return { ok: true, value: value as string[] };
}

/** SPEC §5.4: * matches exactly one path segment, and segment counts must be equal. */
export function capabilityMatches(pattern: string, path: string): boolean {
  const p = pattern.split('.');
  const q = path.split('.');
  if (p.length !== q.length) return false;
  return p.every((seg, i) => seg === '*' || seg === q[i]);
}

export function resolvePaths(patterns: readonly string[]): Set<CapabilityPath> {
  const out = new Set<CapabilityPath>();
  for (const path of CAPABILITY_PATHS) {
    if (patterns.some((pattern) => capabilityMatches(pattern, path))) out.add(path);
  }
  return out;
}

export function capabilityGranted(grant: Grant, path: CapabilityPath): boolean {
  return grant.paths.has(path);
}

/**
 * SPEC §5.4: a path in both effectiveCapabilities and deniedCapabilities makes the message
 * malformed, and the receiver MUST fail closed. An absent effectiveCapabilities is a grant of
 * nothing (§5.3), not a malformed message.
 */
export function parsePolicy(rawParams: unknown): PolicyParse {
  if (rawParams !== undefined && (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))) {
    return { ok: false, error: 'params must be an object' };
  }
  const params = (rawParams ?? {}) as FeatureSetsUpdateParams05;

  let effective: string[] = [];
  let hadEffectiveCapabilities = false;
  if (params.effectiveCapabilities !== undefined) {
    const parsed = stringArray(params.effectiveCapabilities, 'effectiveCapabilities');
    if (!parsed.ok) return parsed;
    effective = parsed.value;
    hadEffectiveCapabilities = true;
  }

  let denied: string[] = [];
  if (params.deniedCapabilities !== undefined) {
    const parsed = stringArray(params.deniedCapabilities, 'deniedCapabilities');
    if (!parsed.ok) return parsed;
    denied = parsed.value;
  }

  const contradiction = effective.filter((p) => denied.includes(p));
  if (contradiction.length > 0) {
    return { ok: false, error: `path(s) in both effectiveCapabilities and deniedCapabilities: ${contradiction.join(', ')}` };
  }

  let enabled: string[] | null = null;
  if (params.enabled !== undefined) {
    const parsed = stringArray(params.enabled, 'enabled');
    if (!parsed.ok) return parsed;
    enabled = parsed.value;
  }

  let disabled: string[] = [];
  if (params.disabled !== undefined) {
    const parsed = stringArray(params.disabled, 'disabled');
    if (!parsed.ok) return parsed;
    disabled = parsed.value;
  }

  return {
    ok: true,
    grant: { patterns: effective, paths: resolvePaths(effective), denied, disabled, enabled },
    hadEffectiveCapabilities,
  };
}

/** SPEC §6.3's feature-set name matching. */
export function featureSetMatches(pattern: string, name: string): boolean {
  if (pattern === name || pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix);
  }
  return false;
}

export type FeatureSetDisabledReason = 'invalid_uses' | 'capability_denied' | 'host_disabled' | 'not_enabled';

export interface FeatureSetState {
  active: boolean;
  missing: string[];
  reason?: FeatureSetDisabledReason;
}

export function deriveFeatureSetState(name: string, decl: FeatureSetDeclaration05, grant: Grant): FeatureSetState {
  const uses = decl.uses;
  if (!Array.isArray(uses) || uses.length === 0 || !uses.every(isCapabilityPath)) {
    return { active: false, missing: [], reason: 'invalid_uses' };
  }
  const missing = uses.filter((path) => !capabilityGranted(grant, path));
  if (missing.length > 0) return { active: false, missing, reason: 'capability_denied' };
  if (grant.disabled.some((pattern) => featureSetMatches(pattern, name))) {
    return { active: false, missing: [], reason: 'host_disabled' };
  }
  if (grant.enabled !== null && !grant.enabled.some((pattern) => featureSetMatches(pattern, name))) {
    return { active: false, missing: [], reason: 'not_enabled' };
  }
  return { active: true, missing: [] };
}

export function buildReceipt(decls: FeatureSetMap, grant: Grant): AcceptedReceipt {
  const unavailable: UnavailableFeature[] = [];
  const notes: string[] = [];
  for (const [name, decl] of Object.entries(decls)) {
    const state = deriveFeatureSetState(name, decl, grant);
    if (state.active) continue;
    unavailable.push({ featureSet: name, missingCapabilities: state.missing, effect: 'disabled' });
    if (state.reason === 'invalid_uses') notes.push(`${name}: declaration is invalid (uses)`);
    if (state.reason === 'host_disabled') notes.push(`${name}: disabled by host policy`);
    if (state.reason === 'not_enabled') notes.push(`${name}: not listed in enabled`);
    if (state.reason === 'capability_denied') {
      notes.push(`${name}: disabled — scheduled wakes will not be delivered while ${state.missing.join(', ')} is denied; tools remain answerable over plain MCP`);
    }
  }
  return {
    accepted: true,
    ...(unavailable.length === 0 ? {} : { mode: 'degraded' as const }),
    unavailableFeatures: unavailable,
    notes,
  };
}

/** SPEC §6.7: a Notification can't establish a ready state, and a server MUST immediately respect
 *  a reduction. */
export function narrowGrant(current: Grant, incoming: Grant, incomingHasCapabilities: boolean): Grant {
  const paths = incomingHasCapabilities
    ? new Set<CapabilityPath>([...current.paths].filter((p) => incoming.paths.has(p)))
    : current.paths;
  let enabled = current.enabled;
  if (incoming.enabled !== null) {
    enabled = current.enabled === null
      ? incoming.enabled
      : current.enabled.filter((name) => incoming.enabled!.includes(name));
  }
  return {
    patterns: incomingHasCapabilities ? [...paths] : current.patterns,
    paths,
    denied: [...current.denied, ...incoming.denied],
    disabled: [...current.disabled, ...incoming.disabled],
    enabled,
  };
}
