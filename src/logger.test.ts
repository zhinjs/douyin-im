import type { LogTransport } from '@zhin.js/logger';
import { configureLogger, getAccountLogger, getLogger, setLogLevel } from './logger.js';

class CaptureTransport implements LogTransport {
  readonly lines: string[] = [];

  write(formatted: string): void {
    this.lines.push(formatted);
  }
}

describe('logger facade', () => {
  afterEach(() => {
    configureLogger({ level: 'silent' });
  });

  it('stays silent until the host enables logging', () => {
    const transport = new CaptureTransport();
    const logger = getLogger('Test:Silent');
    configureLogger({ transports: [transport] });

    logger.error('hidden by the SDK default');

    expect(transport.lines).toEqual([]);
  });

  it('creates stable DouyinIM namespaces', () => {
    const first = getLogger('Runtime:Test');
    const second = getLogger('Runtime:Test');

    expect(first).toBe(second);
    expect(first.getName()).toBe('DouyinIM:Runtime:Test');
  });

  it('creates oicq-style account categories', () => {
    expect(getAccountLogger('1150530166719210').getName()).toBe('Douyin:1150530166719210');
    expect(getAccountLogger().getName()).toBe('Douyin:pending');
  });

  it('applies configuration and level changes to existing loggers', () => {
    const transport = new CaptureTransport();
    const logger = getLogger('Test:Levels');
    configureLogger({ level: 'error', color: false, transports: [transport] });

    logger.info('hidden');
    logger.error('visible error');
    expect(transport.lines).toHaveLength(1);
    expect(transport.lines[0]).toContain('visible error');

    setLogLevel('debug');
    logger.debug('visible debug');
    expect(transport.lines).toHaveLength(2);
    expect(transport.lines[1]).toContain('visible debug');
  });
});
