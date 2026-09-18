import { DesktopBdmsConfiguration, type DesktopConfigContext, type DesktopBdmsInitOptions } from './desktop-config.js';
import { DesktopBehaviorCollector, type DesktopBehaviorInputContext } from './desktop-behavior-collector.js';
import { DesktopEnvironmentState } from './desktop-environment-mask.js';
import { DesktopRequestSigner, type DesktopSigningContext } from './desktop-request-signer.js';
import { DesktopDeviceReporter, type DesktopDeviceReportContext } from './desktop-device-report.js';
import { DesktopTokenState, type DesktopTokenContext } from './desktop-token.js';
import { DesktopReportSender, type DesktopReportContext } from './desktop-report.js';
import { DesktopReportLifecycle, type DesktopReportLifecycleContext } from './desktop-report-lifecycle.js';
import { collectDesktopReportScreen } from './desktop-fingerprint.js';
import { installDesktopXhrHook, type DesktopXhrHookContext } from './desktop-xhr-hook.js';
import { installDesktopFetchHook, type DesktopFetchHookContext } from './desktop-fetch-hook.js';
import { installDesktopEventSourceHook, type DesktopEventSourceHookContext } from './desktop-eventsource-hook.js';
import { initializeDesktopReferer, initializeDesktopVersion, type DesktopStartupContext } from './desktop-startup.js';

/** Bindings must all belong to the same owned browser context; no fabricated host defaults. */
export type DesktopBdmsRuntimeContext = DesktopConfigContext & DesktopBehaviorInputContext &
  DesktopSigningContext & DesktopDeviceReportContext & DesktopTokenContext & DesktopReportContext &
  DesktopReportLifecycleContext & DesktopXhrHookContext & DesktopFetchHookContext & DesktopEventSourceHookContext & DesktopStartupContext;

/**
 * One-context assembly. Construction captures report methods then installs XHR/fetch/EventSource.
 * init changes shared config and starts collection/reporting, never reinstalls hooks.
 * The owner must dispose the entire browser context to end its timers/listeners/requests.
 */
export class DesktopBdmsRuntime {
  private readonly configuration: DesktopBdmsConfiguration;
  private readonly device: DesktopDeviceReporter;
  private readonly lifecycle: DesktopReportLifecycle;

  constructor(private readonly context: DesktopBdmsRuntimeContext) {
    const behavior = new DesktopBehaviorCollector(context);
    const environment = new DesktopEnvironmentState(context);
    initializeDesktopReferer(context);
    initializeDesktopVersion(context);
    this.configuration = new DesktopBdmsConfiguration(context, () => this.lifecycle.start());
    const config = this.configuration.config;
    const tokens = new DesktopTokenState(context);
    const sender = new DesktopReportSender(context, config, tokens, () => this.device.report());
    this.device = new DesktopDeviceReporter(context, config, environment, behavior, sender);
    const signer = new DesktopRequestSigner(context, config, behavior, environment);
    this.lifecycle = new DesktopReportLifecycle(context, config,
      behavior.createReportSources(() => collectDesktopReportScreen(context)),
      sender, this.device.report, behavior.startCollection);
    const callbacks = {
      matchesSigning: (path: string) => this.configuration.matchesSigning(path),
      matchesBehavior: (path: string) => this.configuration.matchesBehavior(path),
      sign: (query: string, body: unknown, type?: string) => signer.sign(query, body, type),
      reportBehavior: this.lifecycle.reportBehavior,
    };
    installDesktopXhrHook(context, tokens, callbacks);
    installDesktopFetchHook(context, tokens, callbacks);
    installDesktopEventSourceHook(context, tokens, callbacks);
  }

  readonly init = (options: DesktopBdmsInitOptions): void => { this.configuration.init(options); };
  readonly getReferer = (): unknown => this.context.window.__ac_referer || '';
}

/** Original module guard/export. Existing truthy bdms is deliberately not validated or replaced. */
export function installDesktopBdms(context: DesktopBdmsRuntimeContext): void {
  if (context.window.bdms) return;
  const exported = {};
  if (typeof context.Symbol !== 'undefined' && context.Symbol.toStringTag) {
    context.Object.defineProperty(exported, context.Symbol.toStringTag, { value: 'Module' });
  }
  context.Object.defineProperty(exported, '__esModule', { value: true });
  context.Object.defineProperty(exported, 'getReferer', { enumerable: true, get: () => runtime.getReferer });
  context.Object.defineProperty(exported, 'init', { enumerable: true, get: () => runtime.init });
  const runtime = new DesktopBdmsRuntime(context);
  // Only this outer assignment is outside the original bundle's strict closure.
  // Ignore a false result, but propagate an explicit setter/trap exception after hooks installed.
  Reflect.set(context.window, 'bdms', exported);
}
