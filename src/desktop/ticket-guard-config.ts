import type { DesktopApplicationSettings } from './settings.js';

/** Fields accepted by this Desktop N-API bridge, not the generic mobile config. */
export interface TicketGuardSessionConfig {
  enable?: boolean;
  ree_enable_symmetric?: boolean;
  ree_path?: string[];
  ree_path_prefix?: string[];
  ree_exclude_path?: string[];
  ree_exclude_path_prefix?: string[];
  config_version?: string;
}

const DEFAULT_CONFIG: TicketGuardSessionConfig = {
  enable: true, ree_enable_symmetric: true,
  ree_path: ['/passport/account/info/v2/', '/aweme/v1/web/commit/follow/user/',
    '/passport/token/beat/web/', '/passport/token/beat/v2/', '/webcast/room/create/'],
};
const PATH_FIELDS = ['ree_path', 'ree_path_prefix', 'ree_exclude_path', 'ree_exclude_path_prefix'] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown> : undefined;
}

/** Native ignores wrong field types; an accepted empty array still replaces the config. */
export function filterTicketSessionConfig(value: unknown): TicketGuardSessionConfig {
  const source = record(value); const result: TicketGuardSessionConfig = {};
  if (!source) return result;
  for (const key of ['enable', 'ree_enable_symmetric'] as const) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  for (const key of PATH_FIELDS) {
    const paths = source[key];
    if (Array.isArray(paths)) result[key] = paths.filter((path): path is string => typeof path === 'string');
  }
  if (typeof source['config_version'] === 'string') result.config_version = source['config_version'];
  return result;
}

/** Main selects one object; N-API replaces its Session subconfig only when filtered fields exist. */
export function desktopTicketPolicy(settings?: DesktopApplicationSettings, cached?: TicketGuardSessionConfig): {
  enabled: boolean; session: TicketGuardSessionConfig;
} {
  const previous = filterTicketSessionConfig(cached);
  if (settings?.['bdticket_switch'] === false) return { enabled: false, session: previous };
  const selected = settings?.['bdticket_config'] || { session_guard_config: DEFAULT_CONFIG };
  // The wrapper rejects truthy non-objects and Main leaves its hook disabled.
  if (typeof selected !== 'object' || selected === null) return { enabled: false, session: previous };
  const update = filterTicketSessionConfig(record(selected)?.['session_guard_config']);
  return { enabled: true, session: Object.keys(update).length ? update : previous };
}

/** Only requests are slash-normalized; exclusions always win over allow rules. */
export function ticketSessionPathMatches(config: TicketGuardSessionConfig, pathname: string): boolean {
  if (!config.enable) return false;
  const path = pathname && !pathname.endsWith('/') ? `${pathname}/` : pathname;
  const prefixed = (values?: readonly string[]): boolean => values?.some(prefix => !!prefix && path.startsWith(prefix)) ?? false;
  if (config.ree_exclude_path?.includes(path) || prefixed(config.ree_exclude_path_prefix)) return false;
  return !!config.ree_path?.includes(path) || prefixed(config.ree_path_prefix);
}
