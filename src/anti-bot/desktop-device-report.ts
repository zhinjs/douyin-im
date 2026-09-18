import { setDesktopProperty } from './desktop-property-write.js';
import { collectDesktopBattery, type DesktopBatteryContext } from './desktop-battery.js';
import { DesktopDocumentCollector, type DesktopDocumentContext } from './desktop-device-properties.js';
import { DesktopDeviceIdentityCollector, type DesktopDeviceIdentityContext } from './desktop-device-identity.js';
import { DesktopNavigatorCollector, type DesktopNavigatorContext } from './desktop-navigator.js';
import { collectDesktopPlugins, type DesktopPluginsContext } from './desktop-plugins.js';
import { collectDesktopReportScreen, type DesktopScreenContext } from './desktop-fingerprint.js';
import { collectDesktopWebGl, type DesktopWebGlContext } from './desktop-webgl.js';
import { DesktopWindowCollector, type DesktopWindowContext } from './desktop-window.js';
import type { DesktopEnvironmentState } from './desktop-environment-mask.js';
import type { DesktopBehaviorState } from './desktop-behavior.js';
import type { DesktopReportSender } from './desktop-report.js';

export type DesktopDeviceReportContext = DesktopBatteryContext & DesktopDocumentContext &
  DesktopDeviceIdentityContext & DesktopNavigatorContext & DesktopPluginsContext & DesktopScreenContext &
  DesktopWebGlContext & DesktopWindowContext;

/** Full device path, sharing the host and M/q state with signing and behavior reports. */
export class DesktopDeviceReporter {
  private readonly document: DesktopDocumentCollector;
  private readonly navigator: DesktopNavigatorCollector;
  private readonly window: DesktopWindowCollector;
  private readonly identity: DesktopDeviceIdentityCollector;

  constructor(
    private readonly context: DesktopDeviceReportContext,
    private readonly config: { readonly aid: number; readonly pageId: number },
    private readonly environment: Pick<DesktopEnvironmentState, 'mask'>,
    private readonly behavior: Pick<DesktopBehaviorState, 'mask'>,
    private readonly sender: Pick<DesktopReportSender, 'send'>,
  ) {
    this.document = new DesktopDocumentCollector(context);
    this.identity = new DesktopDeviceIdentityCollector(context);
    this.navigator = new DesktopNavigatorCollector(context, this.document);
    this.window = new DesktopWindowCollector(context, this.document);
  }

  /** Suitable for lifecycle timers and first-token RAF; failures reject without a partial send. */
  readonly report = async (): Promise<void> => {
    const battery = await collectDesktopBattery(this.context);
    const document = this.document.collect();
    const navigator = this.navigator.collect();
    const plugins = collectDesktopPlugins(this.context);
    const screen = collectDesktopReportScreen(this.context);
    const webgl = collectDesktopWebGl(this.context);
    const window = this.window.collect();
    const wID = await this.identity.collect();
    const envCode = this.environment.mask();
    // Device reports use raw q even when init/signing is in mode 1 or 2.
    const ubCode = this.behavior.mask();
    const report = { battery, document, navigator, plugins, screen, webgl, window, wID, envCode, ubCode };
    // Both config values are read after the awaits and masks, with no extra await before send.
    setDesktopProperty(report.wID, 'aid', this.config.aid);
    setDesktopProperty(report.wID, 'pageId', this.config.pageId);
    this.sender.send(report);
  };
}
