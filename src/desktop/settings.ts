import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_APP_VERSION } from './constants.js';

export type DesktopApplicationSettings = Record<string, unknown>;
export interface MessageFloatHintConfig {
  enable: boolean;
  notHintMessages: Readonly<Record<string, readonly number[]>>;
  notFloatMessages?: Readonly<Record<string, readonly number[]>>;
}

export function desktopSettingsUrl(deviceId: string, installId: string, channel: string,
  platform: string = process.platform, arch: string = process.arch): string {
  const query = new URLSearchParams({ aid: '339757', iid: installId, device_id: deviceId, channel: 'prod',
    device_platform: platform, version_code: DESKTOP_APP_VERSION, node_arch: arch,
    from_aid: '339757', from_channel: channel, from_version: DESKTOP_APP_VERSION, app_arch: arch });
  return `https://imdesktop.douyin.com/service/settings/v3/?${query}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** SettingsMgr accepts message=success and data.settings, not status_code or user/settings. */
export function parseDesktopSettings(value: unknown): DesktopApplicationSettings {
  if (!object(value) || value['message'] !== 'success' || !object(value['data']) || !object(value['data']['settings'])) {
    throw new Error('Desktop application settings response is invalid');
  }
  return value['data']['settings'];
}

/** Ui() projects the two independent maps into ImOption repeated int32 values. */
export function desktopFloatHintConfig(settings?: DesktopApplicationSettings): MessageFloatHintConfig | undefined {
  const config = settings?.['im_msg_not_float_not_hint'];
  if (!object(config) || !config['enable']) return undefined;
  return { enable: true, notHintMessages: configMap(config['not_hint_config']),
    notFloatMessages: configMap(config['not_float_config']) };
}

function configMap(source: unknown): Readonly<Record<string, readonly number[]>> {
  const result: Record<string, readonly number[]> = {};
  if (source !== undefined && source !== null) {
    if (!object(source)) throw new Error('Invalid Desktop float/hint config');
    for (const [key, values] of Object.entries(source)) {
      if (!/^-?\d+$/.test(key) || !Array.isArray(values) || !values.every(value => typeof value === 'number' && Number.isSafeInteger(value))) {
        throw new Error('Invalid Desktop float/hint config entry');
      }
      const type = BigInt(key);
      if (type < -2147483648n || type > 2147483647n) throw new Error('Invalid Desktop float/hint config type');
      // Do not guess safe_stoi overflow behavior; valid keys and protobuf int32 list values only.
      result[String(type)] = values.map(value => value | 0);
    }
  }
  return result;
}

/** Read-only startup snapshot; never fetches or starts the refresh timer. */
export function readDesktopSettings(directory: string, identity: string): DesktopApplicationSettings | undefined {
  try {
    const stored: unknown = JSON.parse(readFileSync(join(directory, 'desktop-settings.json'), 'utf8'));
    if (object(stored) && stored['version'] === 1 && stored['identity'] === identity && object(stored['settings'])) {
      desktopFloatHintConfig(stored['settings']);
      return stored['settings'];
    }
  } catch { /* Invalid/unrelated cache is not a reason to change account credentials. */ }
  return undefined;
}

/** Account/device-scoped SettingsMgr cache; refreshes do not mutate an already-created IM option snapshot. */
export class DesktopSettings {
  private readonly file: string;
  private value: DesktopApplicationSettings | undefined;
  private task: Promise<DesktopApplicationSettings | undefined> | undefined;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly options: {
    directory: string;
    identity: string;
    request(signal: AbortSignal): Promise<DesktopApplicationSettings | undefined>;
    onError(error: unknown): void;
  }) {
    this.file = join(options.directory, 'desktop-settings.json');
    this.value = readDesktopSettings(options.directory, options.identity);
  }

  snapshot(): DesktopApplicationSettings | undefined { return this.value && structuredClone(this.value); }

  async start(): Promise<DesktopApplicationSettings | undefined> {
    if (this.stopped) return undefined;
    this.timer ??= setInterval(() => { void this.refresh(); }, 7_200_000);
    this.timer.unref();
    // An SDK has no pre-login app-ready phase: finish one bounded read before building IM options.
    return this.refresh();
  }

  /** Device onUpdate restarts SettingsMgr, without rebuilding the running IM option snapshot. */
  restart(identity: string): Promise<DesktopApplicationSettings | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.task = undefined;
    this.options.identity = identity;
    return this.start();
  }

  refresh(): Promise<DesktopApplicationSettings | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    if (this.task) return this.task.then(value => value && structuredClone(value));
    const controller = new AbortController();
    this.controller = controller;
    const task = (async () => {
      try {
        const settings = await this.options.request(controller.signal);
        if (this.stopped || controller.signal.aborted) return undefined;
        if (!settings) return this.snapshot();
        desktopFloatHintConfig(settings); // Malformed relevant config must not replace the last usable snapshot.
        this.value = structuredClone(settings);
        mkdirSync(this.options.directory, { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, JSON.stringify({ version: 1, identity: this.options.identity, settings: this.value }), { mode: 0o600 });
        renameSync(temporary, this.file);
      } catch (error) {
        if (!this.stopped && !controller.signal.aborted) this.options.onError(error);
      }
      return this.stopped ? undefined : this.snapshot();
    })();
    this.task = task;
    const done = (): void => { if (this.task === task) { this.task = undefined; this.controller = undefined; } };
    void task.then(done, done);
    return task;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
}
