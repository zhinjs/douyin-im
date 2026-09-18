import { createHash } from 'node:crypto';
import {
  createDesktopDTraitBoolCollector,
  type DesktopDTraitBoolContext,
  type DesktopDTraitImageProbe,
} from './desktop-dtrait-bool.js';

function fixture() {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const image = {
    id: '',
    src: '',
    style: { cssText: '' },
    parentNode: null as DesktopDTraitImageProbe['parentNode'],
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  const body = {
    appendChild: jest.fn(() => {
      image.parentNode = body;
    }),
    removeChild: jest.fn(() => {
      image.parentNode = null;
    }),
  };
  const getElementById = jest.fn((id: string) =>
    id === 'image_disable' ? image : null
  );
  const document = {
    body,
    createElement: jest.fn(() => image),
    getElementById,
    getElementsByClassName: jest.fn(() => ({ length: 0 })),
    createEvent: jest.fn(),
  };
  const rtcConstruct = jest.fn(),
    rtcClose = jest.fn();
  const context: DesktopDTraitBoolContext = {
    document,
    navigator: {
      brave: false,
      cookieEnabled: true,
      doNotTrack: '0',
      pdfViewerEnabled: false,
      serviceWorker: {},
      webdriver: 'false',
    },
    RTCPeerConnection: class {
      constructor() {
        rtcConstruct();
      }
      close() {
        rtcClose();
      }
    },
    Date: { now: jest.fn(() => 100) },
    setTimeout: jest.fn((callback, delay) => {
      void delay;
      timers.set(++nextTimer, callback);
      return nextTimer;
    }),
    clearTimeout: jest.fn(timer => {
      timers.delete(timer as number);
    }),
    onDiagnostic: jest.fn(),
  };
  return {
    context,
    document,
    image,
    body,
    timers,
    rtcConstruct,
    rtcClose,
    collect: createDesktopDTraitBoolCollector(context),
  };
}

describe('Desktop DTrait boolean collector', () => {
  it('uses pinned image bytes and awaits image before reading navigator flags', async () => {
    const f = fixture();
    const brave = jest.fn(() => false);
    Object.defineProperty(f.context.navigator, 'brave', { get: brave });
    const pending = f.collect();
    expect(brave).not.toHaveBeenCalled();
    expect(f.image.id).toBe('image_disable');
    expect(f.image.style.cssText).toBe('\n    display: none;\n    ');
    expect(f.image.src).toHaveLength(1106);
    expect(createHash('sha256').update(f.image.src).digest('hex')).toBe(
      '23918dc76a5875aecb884c90ea7f07d6fd03764ebbcd9b4476ed75118afa4449'
    );
    expect(f.context.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      500
    );
    expect(f.rtcConstruct).toHaveBeenCalledTimes(1);
    expect(f.document.createEvent).toHaveBeenCalledWith('TouchEvent');
    f.image.onload!();
    await expect(pending).resolves.toEqual({
      bool_1: 0,
      bool_2: 0,
      bool_3: 0,
      bool_4: 1,
      bool_5: 1,
      bool_6: 0,
      bool_7: 1,
      bool_8: 1,
      bool_9: 1,
      bool_10: 0,
    });
    expect(brave).toHaveBeenCalledTimes(1);
    expect(f.rtcClose).not.toHaveBeenCalled();
    expect(f.image.parentNode).toBeNull();
  });

  it.each(['error', 'timeout'])(
    'marks disabled for image %s with the correct timer cleanup',
    async mode => {
      const f = fixture(),
        pending = f.collect();
      if (mode === 'error') f.image.onerror!();
      else f.timers.get(1)!();
      await expect(pending).resolves.toMatchObject({ bool_2: 1 });
      expect(f.context.clearTimeout).toHaveBeenCalledTimes(
        mode === 'error' ? 1 : 0
      );
    }
  );

  it('resolves missing image lookup as enabled after scheduling and clearing the timer', async () => {
    const f = fixture();
    f.document.getElementById.mockReturnValue(null);
    await expect(f.collect()).resolves.toMatchObject({ bool_2: 0 });
    expect(f.context.setTimeout).toHaveBeenCalledTimes(1);
    expect(f.context.clearTimeout).toHaveBeenCalledWith(1);
    expect(f.body.removeChild).toHaveBeenCalledTimes(1);
  });

  it('attaches callbacks to the queried node but cleans up the newly created image', async () => {
    const f = fixture(),
      other = { ...f.image };
    f.document.getElementById.mockImplementation(id =>
      id === 'image_disable' ? other : null
    );
    const pending = f.collect();
    expect(f.image.onload).toBeNull();
    other.onload!();
    await expect(pending).resolves.toMatchObject({ bool_2: 0 });
    expect(f.body.removeChild).toHaveBeenCalledWith(f.image);
  });

  it('short-circuits palette lookup on class match, with independent RTC and Touch failures', async () => {
    const f = fixture();
    f.document.getElementsByClassName.mockReturnValue({ length: 1 });
    f.document.createEvent.mockImplementation(() => {
      throw Error('touch');
    });
    f.rtcConstruct.mockImplementation(() => {
      throw Error('rtc');
    });
    const pending = f.collect();
    f.image.onload!();
    await expect(pending).resolves.toMatchObject({
      bool_1: 1,
      bool_9: 0,
      bool_10: 1,
    });
    expect(f.document.getElementById).not.toHaveBeenCalledWith(
      'automa-palette'
    );
  });

  it('rejects executor failures through the diagnostic chain, not an all-zero fallback', async () => {
    const f = fixture();
    f.body.appendChild.mockImplementation(() => {
      throw Error('append');
    });
    await expect(f.collect()).rejects.toThrow('append');
    expect(f.context.onDiagnostic).toHaveBeenCalledWith('bool');
  });

  it('does not expand F206 catch over synchronous Automa failure', async () => {
    const f = fixture();
    f.document.getElementsByClassName.mockImplementation(() => {
      throw Error('automa');
    });
    await expect(f.collect()).rejects.toThrow('automa');
    expect(f.context.onDiagnostic).not.toHaveBeenCalled();
    expect(f.image.parentNode).toBe(f.body);
    f.image.onload!();
  });

  it('observes a rejected image even when a later synchronous helper prevents Promise.all', async () => {
    const f = fixture();
    f.body.appendChild.mockImplementation(() => {
      throw Error('append');
    });
    f.document.getElementsByClassName.mockImplementation(() => {
      throw Error('automa');
    });
    await expect(f.collect()).rejects.toThrow('automa');
    expect(f.context.onDiagnostic).not.toHaveBeenCalled();
  });

  it('late callbacks still clear timers and read time without changing the settled result', async () => {
    const f = fixture(),
      pending = f.collect();
    f.timers.get(1)!();
    const result = await pending;
    f.image.onload!();
    expect(result.bool_2).toBe(1);
    expect(f.context.Date.now).toHaveBeenCalledTimes(3);
    expect(f.context.clearTimeout).toHaveBeenCalledTimes(1);
  });

  it('preserves pending outcome if an asynchronous cleanup callback throws', async () => {
    const f = fixture();
    f.body.removeChild.mockImplementation(() => {
      throw Error('remove');
    });
    let state = 'pending';
    void f.collect().then(
      () => {
        state = 'resolved';
      },
      () => {
        state = 'rejected';
      }
    );
    expect(() => f.timers.get(1)!()).toThrow('remove');
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(state).toBe('pending');
    expect(f.context.onDiagnostic).not.toHaveBeenCalled();
  });
});
