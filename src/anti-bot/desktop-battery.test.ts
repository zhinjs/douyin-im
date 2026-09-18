import { collectDesktopBattery } from './desktop-battery.js';

describe('Desktop H battery collector', () => {
  it('calls getBattery synchronously on its navigator but reads fields after awaiting', async () => {
    const trace: string[] = [];
    let release!: (battery: object) => void;
    const navigator = { getBattery() { expect(this).toBe(navigator); trace.push('getBattery'); return new Promise(resolve => { release = resolve; }); } };
    const pending = collectDesktopBattery({ navigator, Math });
    trace.push('returned');
    expect(trace).toEqual(['getBattery', 'returned']);
    release({ get charging() { trace.push('charging'); return true; }, chargingTime: Infinity, dischargingTime: 0, level: .555 });
    expect(await pending).toEqual({ charging: 1, chargingTime: 'Infinity', dischargingTime: '0', level: 56 });
    expect(trace).toEqual(['getBattery', 'returned', 'charging']);
  });
  it('preserves default/number conversion hints and Math receiver/order', async () => {
    const trace: string[] = [];
    const value = { [Symbol.toPrimitive](hint: string) { trace.push(hint); return 2; } };
    const math = { get round() { trace.push('round'); return function(this: unknown, n: number) { expect(this).toBe(math); return Math.round(n); }; } };
    const result = await collectDesktopBattery({ Math: math, navigator: { getBattery: () => ({ charging: [], chargingTime: value, dischargingTime: value, get level() { trace.push('level'); return value; } }) } });
    expect(result).toEqual({ charging: 1, chargingTime: '2', dischargingTime: '2', level: 200 });
    expect(trace).toEqual(['default', 'default', 'round', 'level', 'number']);
  });
  it('does not cache results or normalize missing fields to a failed report', async () => {
    let calls = 0;
    const getBattery = () => { calls++; return {}; };
    const context = { navigator: { getBattery }, Math };
    const first = await collectDesktopBattery(context);
    expect(first).toEqual({ charging: 2, chargingTime: 'undefined', dischargingTime: 'undefined', level: NaN });
    expect(await collectDesktopBattery(context)).not.toBe(first);
    expect(calls).toBe(2);
  });
  it.each(['charging', 'chargingTime', 'dischargingTime', 'level'])('discards partial results after %s throws', key => {
    const battery = new Proxy({}, { get(_target, name) { if (name === key) throw Error(key); return undefined; } });
    return expect(collectDesktopBattery({ navigator: { getBattery: () => battery }, Math })).resolves.toEqual({});
  });
  it('returns fresh empty objects on absent API, rejected promise and conversion errors', async () => {
    const first = await collectDesktopBattery({ navigator: {}, Math });
    expect(first).toEqual({});
    expect(await collectDesktopBattery({ navigator: {}, Math })).not.toBe(first);
    for (const value of [Promise.reject(Error('battery')), null, { chargingTime: Symbol('bad') }, { level: 1n }]) {
      expect(await collectDesktopBattery({ navigator: { getBattery: () => value }, Math })).toEqual({});
    }
  });
});
