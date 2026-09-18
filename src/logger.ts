import {
  ConsoleTransport,
  DefaultFormatter,
  LogLevel,
  Logger,
  type LogFormatter,
  type LoggerColorOptions,
  type LogLevelInput,
  type LogTransport,
} from '@zhin.js/logger';

export interface LoggerConfiguration {
  /** SDK 默认 silent；应用或 demo 应在启动时显式设置日志级别。 */
  level?: LogLevelInput;
  /** 默认 true，避免 Cookie、token、key 等凭证被直接打印。 */
  maskSensitive?: boolean;
  /** 非交互环境可关闭 ANSI 颜色。 */
  color?: boolean;
  formatter?: LogFormatter;
  transports?: LogTransport[];
  colors?: LoggerColorOptions;
}

const DEFAULT_LEVEL = LogLevel.SILENT;
const knownLoggers = new Set<Logger>();

let configuration: LoggerConfiguration = {
  level: DEFAULT_LEVEL,
  maskSensitive: true,
  color: true,
};

// @zhin.js/logger 的真正根节点会省略自己的名称，因此保留一个私有 registry 根，
// 将 DouyinIM 作为第一层可见命名空间。
const registryRoot = new Logger(null, '', buildOptions(configuration));
const rootLogger = registryRoot.getLogger('DouyinIM', buildOptions(configuration));
knownLoggers.add(rootLogger);

function buildOptions(options: LoggerConfiguration): {
  level: LogLevelInput;
  formatter: LogFormatter;
  transports: LogTransport[];
} {
  return {
    level: options.level ?? DEFAULT_LEVEL,
    formatter: options.formatter ?? new DefaultFormatter(options.colors),
    transports: options.transports ?? [
      new ConsoleTransport({
        maskSensitive: options.maskSensitive ?? true,
        removeAnsi: options.color === false,
      }),
    ],
  };
}

/**
 * 配置 douyin-im 的整棵日志命名空间。
 *
 * SDK 本身默认静默，宿主应用可以在入口处调用一次：
 * `configureLogger({ level: 'info' })`。
 */
export function configureLogger(options: LoggerConfiguration = {}): Logger {
  configuration = {
    ...configuration,
    ...options,
  };
  const loggerOptions = buildOptions(configuration);
  for (const logger of knownLoggers) logger.setOptions(loggerOptions);
  rootLogger.setLevel(loggerOptions.level, true);
  return rootLogger;
}

/** 获取 `DouyinIM[:scope]` 命名空间 Logger。 */
export function getLogger(scope?: string): Logger {
  if (!scope) return rootLogger;
  const logger = rootLogger.getLogger(scope);
  logger.setOptions(buildOptions(configuration));
  knownLoggers.add(logger);
  return logger;
}

/**
 * 获取账号维度 Logger，输出类别形如 `Douyin:<uid>`。
 *
 * 与 oicq 的 `[platform:account]` 类别一致：账号是运行日志的主语，模块名只用于
 * debug 级协议日志。二维码尚未绑定稳定账号时使用 `pending`。
 */
export function getAccountLogger(accountId?: string): Logger {
  const identity = accountId?.trim() || 'pending';
  const name = `Douyin:${identity}`;
  const logger = registryRoot.getLogger(name);
  logger.setOptions(buildOptions(configuration));
  knownLoggers.add(logger);
  return logger;
}

/** 运行时快速切换日志级别，并同步所有已创建的子 Logger。 */
export function setLogLevel(level: LogLevelInput): void {
  configuration = { ...configuration, level };
  rootLogger.setLevel(level, true);
}

export { LogLevel, Logger } from '@zhin.js/logger';
export type { LogFormatter, LoggerColorOptions, LogLevelInput, LogTransport } from '@zhin.js/logger';
