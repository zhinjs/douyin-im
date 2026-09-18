export {
  generateABogus,
  generateDesktopABogus,
  encodeDesktopReportData,
  type DesktopABogusOptions,
  BDMS_PRESETS,
  DEFAULT_SCREEN_FINGERPRINT,
  MAC_SCREEN_FINGERPRINT,
  WIN_SCREEN_FINGERPRINT,
  type ABogusOptions,
  type BdmsPreset,
} from './aBogus.js';
export {
  DesktopBehaviorState,
  type DesktopBehaviorPoint,
  type DesktopBehaviorSnapshot,
  type DesktopOrientationPoint,
  type DesktopVisibilityPoint,
  type DesktopHoverPoint,
} from './desktop-behavior.js';
export {
  buildDesktopFingerprint,
  type DesktopFingerprintContext,
} from './desktop-fingerprint.js';
export {
  collectDesktopScreenGeometry,
  collectDesktopReportScreen,
  type DesktopScreenContext,
} from './desktop-fingerprint.js';
export {
  DesktopBehaviorCollector,
  type DesktopBehaviorInputContext,
} from './desktop-behavior-collector.js';
export {
  DesktopPropertyClassifier,
  DesktopDocumentCollector,
  type DesktopPropertyContext,
  type DesktopDocumentContext,
} from './desktop-device-properties.js';
export {
  collectDesktopBattery,
  type DesktopBatteryContext,
  type DesktopBatteryResult,
} from './desktop-battery.js';
export {
  DesktopNavigatorCollector,
  type DesktopNavigatorContext,
} from './desktop-navigator.js';
export {
  DesktopWindowCollector,
  type DesktopWindowContext,
} from './desktop-window.js';
export {
  collectDesktopWebGl,
  type DesktopWebGl,
  type DesktopWebGlContext,
} from './desktop-webgl.js';
export {
  DesktopDeviceIdentityCollector,
  type DesktopDeviceIdentityContext,
  type DesktopIdentityImage,
} from './desktop-device-identity.js';
export {
  DesktopDeviceReporter,
  type DesktopDeviceReportContext,
} from './desktop-device-report.js';
export {
  DesktopBdmsConfiguration,
  type DesktopBdmsConfig,
  type DesktopBdmsInitOptions,
  type DesktopConfigContext,
} from './desktop-config.js';
export {
  DesktopWebSecureConfiguration,
  classifyDesktopWebSecureRequest,
  type DesktopWebSecureSceneConfig,
  type DesktopWebSecureMatch,
} from './desktop-web-secure-config.js';
export {
  DesktopWebSecureTcc,
  type DesktopWebSecureTccContext,
  type DesktopWebSecureTccQuery,
  type DesktopWebSecureTccXhr,
} from './desktop-web-secure-tcc.js';
export {
  DesktopWebSecureMemoryCache,
  type DesktopWebSecureCacheContext,
  type DesktopWebSecureCacheSummary,
} from './desktop-web-secure-cache.js';
export {
  DesktopWebSecureLocalStorage,
  DesktopWebSecureAreaStorage,
  DesktopWebSecureMemoryArea,
  createDesktopWebSecureLocalArea,
  createDesktopWebSecureMemoryStorage,
  type DesktopWebStorageBackend,
  type DesktopWebStorageArea,
  type DesktopWebStorageValue,
} from './desktop-web-secure-local-storage.js';
export {
  DesktopWebSecureIndexedStorageHost,
  type DesktopWebIdbContext,
  type DesktopWebIdbConfig,
  type DesktopWebIdbFactory,
  type DesktopWebIdbDatabase,
  type DesktopWebIdbOpenRequest,
  type DesktopWebIdbRequest,
  type DesktopWebIdbStore,
  type DesktopWebIdbTransaction,
} from './desktop-web-secure-indexed-storage.js';
export {
  DesktopWebSecureBridgeHost,
  dispatchDesktopWebSecureSocketMessage,
  type DesktopWebSecureBridgeContext,
  type DesktopWebSecureBridgeClient,
  type DesktopWebSecureBridgeMessage,
  type DesktopWebSecureSocketEvent,
  type DesktopWebSecureSocketConfig,
  type DesktopWebSecureSocketDispatcher,
} from './desktop-web-secure-bridge.js';
export {
  DesktopWebSecureIframeHost,
  DesktopWebSecureIframeConnection,
  type DesktopStorageIframeContext,
  type DesktopStorageIframeConfig,
  type DesktopStorageConnectedFrame,
  type DesktopStorageFrameTarget,
  type DesktopStorageFrameNode,
  type DesktopStorageFrameParent,
  type DesktopStorageFrameContainer,
  type DesktopStorageFrameElement,
  type DesktopStorageFrameEvent,
} from './desktop-web-secure-iframe.js';
export { DesktopWebSecureEvents } from './desktop-web-secure-events.js';
export {
  DesktopWebSecureSdk,
  type DesktopWebSecureSdkContext,
  type DesktopWebSecureTelemetry,
  type DesktopWebSecureDTraitOptions,
} from './desktop-web-secure-sdk.js';
export {
  DesktopPassportSecurePlugin,
  type DesktopPassportSecurePluginProps,
  type DesktopPassportSecurePluginContext,
  type DesktopPassportSecureOptions,
} from './desktop-passport-secure-plugin.js';
export {
  DesktopWebSecureTransportHooks,
  captureDesktopWebSecureTransportFeatures,
  parseDesktopWebSecureResponseHeaders,
  type DesktopWebSecureTransportContext,
  type DesktopWebSecureTransportWindow,
  type DesktopWebSecureTransportFeatures,
  type DesktopWebSecureXhr,
  type DesktopWebSecureXhrPrototype,
} from './desktop-web-secure-transport.js';
export {
  DesktopWebSecureRequestPipeline,
  type DesktopWebSecureRequest,
  type DesktopWebSecureResponse,
  type DesktopWebSecureRequestContext,
  type DesktopWebSecureManualSignData,
  type DesktopWebSecureManualHeaders,
} from './desktop-web-secure-request.js';
export {
  DesktopWebSecureKeys,
  type DesktopWebSecureKeysContext,
  type DesktopWebSecureKeysInfo,
  type DesktopWebSecureKeysSettings,
  type DesktopWebSecureKeysStoreSettings,
  type DesktopWebSecureScene,
  type DesktopWebSecureSignInput,
  type DesktopWebSecureSignedData,
} from './desktop-web-secure-keys.js';
export {
  DesktopWebSecureServerCertificates,
  DESKTOP_WEB_SECURE_SERVER_CERTIFICATE_KEY,
  type DesktopWebSecureServerCertificate,
  type DesktopWebSecureServerCertificateContext,
  type DesktopWebSecureCertificateXhr,
} from './desktop-web-secure-server-certificate.js';
export {
  DesktopWebSecureSystemCrypto,
  desktopWebSecureSignatureDer,
  type DesktopWebSecurePemPair,
  type DesktopWebSecureSignature,
} from './desktop-web-secure-crypto.js';
export {
  DesktopWebSecureSocket,
  type DesktopWebSecureSocketOptions,
  type DesktopWebSecureSocketContext,
  type DesktopWebSecureSocketConnection,
} from './desktop-web-secure-socket.js';
export {
  DesktopWebSecureCrossStorage,
  type DesktopCrossStorageConfig,
  type DesktopCrossStorageContext,
  type DesktopCrossStorageOptions,
  type DesktopCrossStorageValue,
} from './desktop-web-secure-cross-storage.js';
export {
  DesktopWebSecureStore,
  type DesktopWebSecureStoreConfig,
  type DesktopWebSecureStoreContext,
  type DesktopWebSecureOriginValues,
} from './desktop-web-secure-store.js';
export {
  createDesktopWebSecureCookieDigest,
  verifyDesktopWebSecureCookie,
  readDesktopWebSecureCookie,
  DesktopWebSecureCookieOperator,
} from './desktop-web-secure-cookie.js';
export {
  DesktopWebSecureKeyStore,
  DESKTOP_WEB_SECURE_INIT_KEYS,
  type DesktopWebSecureKeyStoreOptions,
  type DesktopWebSecureKeyStoreContext,
  type DesktopWebSecureCachedOriginValues,
} from './desktop-web-secure-key-store.js';
export {
  collectDesktopPlugins,
  type DesktopPluginMime,
  type DesktopPlugin,
  type DesktopPluginsContext,
} from './desktop-plugins.js';
export {
  classifyDesktopBrowser,
  classifyDesktopOS,
  classifyDesktopPlatform,
  DesktopStorageState,
  type DesktopStorageContext,
} from './desktop-environment.js';
export {
  DesktopEnvironmentState,
  type DesktopEnvironmentContext,
} from './desktop-environment-mask.js';
export {
  DesktopRequestSigner,
  type DesktopSigningContext,
  type DesktopSigningConfig,
} from './desktop-request-signer.js';
export {
  DesktopTokenState,
  signDesktopXhrUrl,
  type DesktopTokenContext,
  type DesktopXhrUrlContext,
} from './desktop-token.js';
export {
  installDesktopXhrHook,
  type DesktopHookXhr,
  type DesktopXhrHookContext,
  type DesktopXhrHookCallbacks,
} from './desktop-xhr-hook.js';
export {
  installDesktopFetchHook,
  type DesktopFetchHookContext,
  type DesktopFetchHookCallbacks,
} from './desktop-fetch-hook.js';
export {
  installDesktopEventSourceHook,
  type DesktopEventSourceHookContext,
  type DesktopEventSourceWrapper,
} from './desktop-eventsource-hook.js';
export {
  DesktopBdmsRuntime,
  installDesktopBdms,
  type DesktopBdmsRuntimeContext,
} from './desktop-runtime.js';
export {
  DesktopReportSender,
  type DesktopReportXhr,
  type DesktopReportContext,
  type DesktopReportConfig,
} from './desktop-report.js';
export {
  DesktopReportLifecycle,
  type DesktopReportLifecycleContext,
  type DesktopReportScheduleConfig,
  type DesktopBehaviorReportSources,
} from './desktop-report-lifecycle.js';
export {
  DesktopDTraitParameters,
  DESKTOP_DTRAIT_PARAMETERS_KEY,
  type DesktopDTraitParametersContext,
  type DesktopDTraitParameterResult,
} from './desktop-dtrait-parameters.js';
export {
  DesktopDTraitBootstrap,
  type DesktopDTraitBootstrapContext,
  type DesktopDTraitCore,
  type DesktopDTraitMonitor,
  type DesktopDTraitScript,
} from './desktop-dtrait-bootstrap.js';
export {
  DesktopDTraitAes,
  DesktopDTraitRsa,
  createDesktopDTraitCryptoUtil,
  installDesktopDTraitCrypto,
  type DesktopDTraitCryptoContext,
  type DesktopDTraitCryptoJS,
  type DesktopDTraitRsaInstance,
  type DesktopDTraitCipher,
} from './desktop-dtrait-crypto.js';
export {
  DesktopDTraitRequestCore,
  createDesktopDTraitCore,
  type DesktopDTraitCoreContext,
  type DesktopDTraitRequestCoreContext,
  type DesktopDTraitCoreMonitor,
  type DesktopDTraitCoreRealmState,
  type DesktopDTraitRequestConfig,
  type DesktopDTraitRequestMeta,
  type DesktopDTraitRequestError,
  type DesktopDTraitFeatureValues,
} from './desktop-dtrait-request-core.js';
export {
  createDesktopDTraitBrowserCollector,
  createDesktopDTraitBrowserCore,
  type DesktopDTraitBrowserRealm,
  type DesktopDTraitBrowserCoreOptions,
} from './desktop-dtrait-browser.js';
export {
  createDesktopDTraitTransportInstaller,
  parseDesktopDTraitResponseHeaders,
  type DesktopDTraitTransportRealm,
  type DesktopDTraitTransportConfig,
  type DesktopDTraitTransportResponse,
  type DesktopDTraitTransportCallbacks,
  type DesktopDTraitTransportDiagnostics,
  type DesktopDTraitTransportXhr,
  type DesktopDTraitFetchResponse,
  type DesktopDTraitFetchInit,
} from './desktop-dtrait-transport.js';
export {
  DesktopDTraitFeatures,
  createDesktopDTraitHash,
  type DesktopDTraitFeatureContext,
  type DesktopDTraitFeatureOptions,
  type DesktopDTraitHashContext,
} from './desktop-dtrait-features.js';
export {
  DesktopDTraitCollector,
  prepareDesktopDTraitCollection,
  type DesktopDTraitCollectionContext,
  type DesktopDTraitCollectionOptions,
  type DesktopDTraitCollectionTask,
  type DesktopDTraitCollectionResult,
  type DesktopDTraitCollectionPlugins,
} from './desktop-dtrait-collector.js';
export {
  createDesktopDTraitMathCollector,
  type DesktopDTraitMathContext,
} from './desktop-dtrait-math.js';
export {
  createDesktopDTraitSvgCollector,
  type DesktopDTraitSvgContext,
  type DesktopDTraitSvgElement,
  type DesktopDTraitSvgParent,
} from './desktop-dtrait-svg.js';
export {
  createDesktopDTraitMediaCollector,
  type DesktopDTraitMediaContext,
} from './desktop-dtrait-media.js';
export {
  createDesktopDTraitSpeechCollector,
  type DesktopDTraitSpeechContext,
  type DesktopDTraitVoice,
} from './desktop-dtrait-speech.js';
export {
  createDesktopDTraitCanvasCollector,
  createDesktopDTraitDomCollector,
  type DesktopDTraitCanvasContext,
  type DesktopDTraitCanvas2D,
  type DesktopDTraitDomContext,
  type DesktopDTraitDomElement,
  type DesktopDTraitDomParent,
} from './desktop-dtrait-rendering.js';
export {
  createDesktopDTraitCssCollector,
  type DesktopDTraitCssContext,
  type DesktopDTraitCssNode,
} from './desktop-dtrait-css.js';
export {
  createDesktopDTraitEnvironmentCollector,
  type DesktopDTraitEnvironmentContext,
  type DesktopDTraitEnvironmentNavigator,
  type DesktopDTraitEnvironmentFeature,
} from './desktop-dtrait-environment.js';
export {
  createDesktopDTraitBoolCollector,
  type DesktopDTraitBoolContext,
  type DesktopDTraitBoolFeature,
  type DesktopDTraitImageProbe,
} from './desktop-dtrait-bool.js';
export {
  createDesktopDTraitWebGLCollector,
  type DesktopDTraitWebGLContext,
  type DesktopDTraitWebGL,
  type DesktopDTraitWebGLCanvas,
} from './desktop-dtrait-webgl.js';
export {
  createDesktopDTraitAudioCollector,
  type DesktopDTraitAudioContext,
  type DesktopDTraitAudioAnalyser,
  type DesktopDTraitOfflineAudio,
} from './desktop-dtrait-audio.js';
export {
  createDesktopDTraitFontsCollector,
  type DesktopDTraitFontsContext,
  type DesktopDTraitFontNode,
  type DesktopDTraitFontFace,
} from './desktop-dtrait-fonts.js';
export {
  installDesktopDTraitBrowser,
  type DesktopDTraitBrowserInstallRealm,
  type DesktopDTraitBrowserDependencies,
} from './desktop-dtrait-browser-install.js';
export {
  createDesktopDTraitBrowserBootstrap,
  DESKTOP_DTRAIT_LOCAL_CORE_VERSION,
  type DesktopDTraitBrowserBootstrapRealm,
  type DesktopDTraitBrowserBootstrapOptions,
} from './desktop-dtrait-browser-bootstrap.js';
export {
  createDesktopWebSecureBrowser,
  startDesktopLoginWebSecure,
  type DesktopLoginWebSecureConfig,
  type DesktopWebSecureBrowserRealm,
  type DesktopWebSecureBrowserOptions,
} from './desktop-web-secure-browser.js';
