export interface DesktopBatteryContext {
  readonly navigator: { getBattery?(): unknown };
  readonly Math: { round(value: number): number };
}

export type DesktopBatteryResult = {
  charging: 1 | 2;
  chargingTime: string;
  dischargingTime: string;
  level: number;
} | Record<string, never>;

/**
 * BDMS .7 H with standard native Promise semantics. Calls only the supplied
 * navigator, once per invocation; no cache, synthetic defaults, timeout or retry.
 */
export async function collectDesktopBattery(context: DesktopBatteryContext): Promise<DesktopBatteryResult> {
  try {
    const battery = await context.navigator.getBattery!() as {
      charging: unknown; chargingTime: string; dischargingTime: string; level: number;
    };
    return {
      charging: battery.charging ? 1 : 2,
      chargingTime: battery.chargingTime + '',
      dischargingTime: battery.dischargingTime + '',
      level: context.Math.round(battery.level * 100),
    };
  } catch {
    // Includes post-await getters and conversions: never return a partial battery report.
    return {};
  }
}
