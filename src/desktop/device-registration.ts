import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encodeDeviceLog } from './device-log.js';

const run = promisify(execFile);
const ORIGIN = 'https://imdesktop.douyin.com';
const CHANNEL = 'local_test';
const VERSION = '1.2.1';
const APP = '抖音聊天';
const headers = { 'Content-Type': 'application/json', 'User-Agent': 'TTNetwork PC' };

export interface DesktopHardware {
  platform: 'darwin' | 'win32';
  release: string;
  model: string;
  uuid: string;
  serial: string;
  sku: string;
  mac: string;
  resolution: string;
  timezone: string;
  timezoneName: string;
  timezoneOffset: number;
  language: string;
}

export interface RegisteredDevice {
  deviceId: string;
  installId: string;
}

/** Hardware stays ephemeral: never persist it in Session or include it in errors. */
export async function readDesktopHardware(): Promise<DesktopHardware> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error('Desktop device registration supports macOS and Windows only');
  }
  const options = { encoding: 'utf8' as const, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 };
  let model = '', uuid = '', serial = '', sku = '', resolution = '';
  if (process.platform === 'darwin') {
    const { stdout } = await run('/usr/sbin/ioreg', ['-c', 'IOPlatformExpertDevice', '-d', '2'], options);
    const property = (name: string): string => {
      const line = stdout.split('\n').find((line) => line.includes(`"${name}" =`));
      return line?.split(' = ')[1]?.replace(/[<>"\r\n]/g, '').trim() ?? '';
    };
    model = property('model');
    uuid = property('IOPlatformUUID').toLowerCase();
    serial = property('IOPlatformSerialNumber');
    sku = property('board-id') || property('target-sub-type');
    // Resolution is optional in the original helper too (headless hosts have no display).
    try {
      const { stdout: graphics } = await run('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], options);
      const adapters = JSON.parse(graphics).SPDisplaysDataType as Array<{ spdisplays_ndrvs?: Array<Record<string, string>> }>;
      const display = adapters.flatMap((adapter) => adapter.spdisplays_ndrvs ?? [])[0];
      const dimensions = (display?.['_spdisplays_resolution'] ?? display?.['spdisplays_resolution'] ?? '').match(/(\d+)\s*x\s*(\d+)/);
      if (dimensions) resolution = `${dimensions[1]}x${dimensions[2]}`;
    } catch { /* Optional display metadata. */ }
  } else {
    // Same WMI classes as Desktop's helper, via CIM on hosts without wmic.exe.
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$s=Get-CimInstance Win32_ComputerSystemProduct; $d=Get-CimInstance Win32_DiskDrive | Where-Object SerialNumber | Select-Object -First 1; @{model=$s.Name;uuid=$s.UUID;serial=$d.SerialNumber} | ConvertTo-Json -Compress'], options);
    const result = JSON.parse(stdout) as Record<string, string>;
    model = result['model']?.trim() ?? '';
    uuid = result['uuid']?.trim() ?? '';
    serial = result['serial']?.trim() ?? '';
  }
  if (!uuid || !serial) throw new Error('Desktop hardware identity unavailable');
  let timezone = new Date().toString().split(' ')[5] ?? '';
  if (process.platform === 'darwin') {
    const { stdout } = await run('/bin/date', ['+%Z\n%z'], options);
    const [name = '', offset = ''] = stdout.trim().split('\n');
    timezone = `${/^[+-]/.test(name) ? 'GMT' : name}${offset}`;
  }
  return {
    platform: process.platform, release: os.release(), model, uuid, serial, sku, resolution,
    mac: Object.values(os.networkInterfaces()).flat().find((entry) => entry?.mac && entry.mac !== '00:00:00:00:00:00')?.mac ?? '',
    timezone, timezoneName: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: -new Date().getTimezoneOffset() * 60,
    language: Intl.DateTimeFormat().resolvedOptions().locale,
  };
}

function platformParams(hardware: DesktopHardware): Record<string, string> {
  return {
    aid: '339757', channel: CHANNEL,
    os: hardware.platform === 'darwin' ? 'MacOS' : 'Windows',
    device_platform: hardware.platform === 'darwin' ? 'MacOS' : 'PC',
    version_code: VERSION,
    ...(hardware.platform === 'darwin'
      ? { macos_uuid: hardware.uuid, macos_serial: hardware.serial }
      : { pc_uuid: hardware.uuid, pc_serial: hardware.serial }),
  };
}

export function buildDeviceRegistration(hardware: DesktopHardware, current?: RegisteredDevice): { url: string; body: Buffer } {
  if (current && [current.deviceId, current.installId].some((id) => !/^(?:0|[1-9]\d*)$/.test(id) || BigInt(id) > 0xffffffffffffffffn)) {
    throw new Error('Invalid saved Desktop device identity');
  }
  const common = platformParams(hardware);
  const query = new URLSearchParams({ ...common, os_version: hardware.release, device_type: common['device_platform']! });
  const body = {
    header: {
      device_id: 0,
      install_id: 0,
      os: common['os'], device_platform: common['device_platform'], sdk_version: '2.0.1',
      aid: 339757, mc: hardware.mac, channel: CHANNEL,
      package: 'com.bytedance.aweme-im-pc.desktop', language: hardware.language,
      app_version: VERSION, os_version: hardware.release, device_model: hardware.model,
      time_zone: hardware.timezone, tz_name: hardware.timezoneName, tz_offset: hardware.timezoneOffset,
      resolution: hardware.resolution, app_region: 'cn', app_language: 'zh-CN', display_name: APP,
      ...(hardware.platform === 'darwin'
        ? { macos_uuid: hardware.uuid, macos_serial: hardware.serial, sku: hardware.sku }
        : { pc_uuid: hardware.uuid, pc_serial: hardware.serial }),
    },
    _gen_time: 0, magic_tag: 'ss_app_log',
  };
  // Preserve JSON integer fields without routing int64 identifiers through Number.
  const json = JSON.stringify(body)
    .replace('"device_id":0', `"device_id":${current?.deviceId ?? '0'}`)
    .replace('"install_id":0', `"install_id":${current?.installId ?? '0'}`);
  return { url: `${ORIGIN}/service/2/desktop/device_register/?${query}`, body: encodeDeviceLog(json) };
}

/** Do not surface response bodies/URLs: both can contain hardware identifiers. */
export async function registerDesktopDevice(hardware: DesktopHardware, current?: RegisteredDevice): Promise<RegisteredDevice> {
  const request = buildDeviceRegistration(hardware, current);
  const response = await fetch(request.url, { method: 'POST', headers, body: request.body, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Desktop device registration HTTP ${response.status}`);
  const result = await response.json() as Record<string, unknown>;
  const id = (value: unknown): string => {
    if ((typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) &&
        (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('Desktop device registration returned an invalid ID');
    }
    return String(value);
  };
  return { deviceId: id(result['device_id_str'] ?? result['device_id']), installId: id(result['install_id_str'] ?? result['install_id']) };
}

export async function activateDesktopDevice(hardware: DesktopHardware, device: RegisteredDevice): Promise<void> {
  const query = new URLSearchParams({ ...platformParams(hardware), app_name: APP, device_id: device.deviceId, iid: device.installId });
  const response = await fetch(`${ORIGIN}/service/2/app_alert/?${query}`, { method: 'POST', headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Desktop device activation HTTP ${response.status}`);
  const result = await response.json() as Record<string, unknown>;
  if (result['message'] !== 'success') throw new Error('Desktop device activation was not confirmed');
}
