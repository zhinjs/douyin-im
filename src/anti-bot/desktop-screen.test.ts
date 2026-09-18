import { buildDesktopFingerprint, collectDesktopScreenGeometry, collectDesktopReportScreen, type DesktopFingerprintContext } from './desktop-fingerprint.js';

describe('Desktop shared Y geometry and X report screen', () => {
  const context: DesktopFingerprintContext = {
    window: { innerWidth: 123.9, innerHeight: -4.7, pageYOffset: 7, screen: { width: 800, height: 600, orientation: { type: 'portrait-primary', angle: 90.9 } } },
    document: { body: null }, navigator: { platform: 'MacIntel' },
  };
  it('shares base geometry without adding orientation fields to the signing fingerprint', () => {
    const geometry = collectDesktopScreenGeometry(context);
    expect(buildDesktopFingerprint(context)).toBe([...Object.values(geometry), 'MacIntel'].join('|'));
    expect(geometry).toMatchObject({ innerWidth: 123, innerHeight: -4, pageXOffset: 7, pageYOffset: 7, clientWidth: -1, clientHeight: -1 });
    expect(collectDesktopReportScreen(context)).toEqual({ ...geometry, orientaionType: 'portrait-primary', orientaionAngle: 90 });
  });
  it('uses missing orientation defaults but still requires base screen', () => {
    expect(collectDesktopReportScreen({ window: { screen: {} }, document: {} })).toMatchObject({ orientaionType: '', orientaionAngle: 0 });
    const bad = { get window(): DesktopFingerprintContext['window'] { throw Error('window'); }, document: {} };
    expect(() => collectDesktopReportScreen(bad)).toThrow('window');
  });
  it('reads pageYOffset twice and never reads pageXOffset', () => {
    let offset = 0;
    const window = { screen: {}, get pageYOffset() { return ++offset; }, get pageXOffset() { throw Error('wrong'); } };
    expect(collectDesktopScreenGeometry({ window, document: {} })).toMatchObject({ pageXOffset: 1, pageYOffset: 2 });
  });
});
