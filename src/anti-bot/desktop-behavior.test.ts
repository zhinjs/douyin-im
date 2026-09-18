import { DesktopBehaviorState } from './desktop-behavior.js';

describe('Desktop BDMS .7 behavior context', () => {
  it('matches the 14 signed-q observations from the original Chromium fixture', () => {
    const state = new DesktopBehaviorState(0);
    const masks = [state.mask()];
    for (const ts of [100, 100]) { state.recordKeydown(ts); masks.push(state.mask()); }
    state.recordMove({ ts: 200, x: 0, y: 0 }); masks.push(state.mask());
    state.recordClickStart({ ts: 300, x: 0, y: 0 }); masks.push(state.mask());
    for (const [ts, x] of [[216, 9999], [340, 1000], [360, 2000], [380, 2000]]) {
      state.recordMove({ ts: ts!, x: x!, y: 0 }); masks.push(state.mask());
    }
    for (const ts of [400, 401, 402, 403, 404]) { state.recordKeydown(ts); masks.push(state.mask()); }
    expect(masks).toEqual([14, 6, 6, 4, 0, 0, 0, 16, 16, 16, 16, 16, 16, 48]);
  });

  it('updates the shared sample threshold on exactly the sixtieth frame, only once', () => {
    const state = new DesktopBehaviorState(1000);
    for (let frame = 1; frame < 60; frame++) state.recordFrame(1000 + frame * 8);
    expect(state.sampleIntervalMs).toBe(16);
    state.recordFrame(1480);
    expect(state.sampleIntervalMs).toBe(8);
    state.recordFrame(9999);
    expect(state.sampleIntervalMs).toBe(8);
    state.recordMove({ ts: 10, x: 0, y: 0 });
    state.recordMove({ ts: 18, x: 1000, y: 0 });
    state.recordMove({ ts: 19, x: 1000, y: 0 });
    expect(state.getSnapshot().moves.map(point => point.ts)).toEqual([10, 19]);
    expect(state.mask()).toBe(28);
  });

  it('does not reset queues on mask reads or mode changes', () => {
    const state = new DesktopBehaviorState(0);
    expect(state.mask()).toBe(14);
    expect(state.mask(1)).toBe(0);
    expect(state.mask(2)).toBe(0);
    expect(state.mask()).toBe(14);
    state.recordMove({ ts: 1, x: 0, y: 0 });
    state.recordClickStart({ ts: 1, x: 0, y: 0 });
    state.recordKeydown(1);
    state.recordMove({ ts: 21, x: 1000, y: 0 });
    expect(state.mask()).toBe(16);
    expect(state.mask(2)).toBe(0);
    expect(state.mask(1)).toBe(0);
    expect(state.mask()).toBe(16);
    expect(state.getSnapshot().moves).toHaveLength(2);
    expect(new DesktopBehaviorState(0).mask()).toBe(14);
  });

  it('bounds queues by dropping only their oldest accepted sample', () => {
    const state = new DesktopBehaviorState(0);
    for (let index = 0; index < 500; index++) {
      state.recordMove({ ts: index * 20, x: index, y: 0 });
      state.recordClickStart({ ts: index * 20, x: index, y: 0 });
      state.recordKeydown(index);
    }
    const snapshot = state.getSnapshot();
    expect(snapshot.moves).toHaveLength(400);
    expect(snapshot.moves[0]?.ts).toBe(2000);
    expect(snapshot.clickStarts).toHaveLength(100);
    expect(snapshot.clickStarts[0]?.ts).toBe(8000);
    expect(snapshot.keydowns).toHaveLength(100);
    expect(snapshot.keydowns[0]?.ts).toBe(400);
  });

  it('uses the mean of inverse key intervals and a strict greater-than threshold', () => {
    const state = new DesktopBehaviorState(0);
    for (const ts of [0, 5, 10, 15, 20, 25]) state.recordKeydown(ts);
    expect(state.mask()).toBe(6);
    const uneven = new DesktopBehaviorState(0);
    for (const ts of [0, 100, 101, 102, 103, 104]) uneven.recordKeydown(ts);
    expect(uneven.mask()).toBe(38);
  });

  it('does not extend filtering windows for rejected samples and allows backwards key times', () => {
    const state = new DesktopBehaviorState(0);
    state.recordMove({ ts: 100, x: 0, y: 0 });
    state.recordMove({ ts: 115, x: 1, y: 0 });
    state.recordMove({ ts: 117, x: 2, y: 0 });
    state.recordMove({ ts: 1000, x: 2, y: 0 });
    state.recordKeydown(10); state.recordKeydown(9); state.recordKeydown(9);
    expect(state.getSnapshot().moves.map(point => point.ts)).toEqual([100, 117]);
    expect(state.getSnapshot().keydowns.map(point => point.ts)).toEqual([10, 9]);
  });

  it('isolates contexts and does not retain caller-owned point objects', () => {
    const state = new DesktopBehaviorState(0), other = new DesktopBehaviorState(0);
    const point = { ts: 1, x: 1, y: 1 };
    state.recordMove(point); point.x = 900;
    const snapshot = state.getSnapshot();
    expect(snapshot.moves[0]?.x).toBe(1);
    expect(state.mask()).toBe(12);
    expect(other.mask()).toBe(14);
  });

  it('filters and bounds click endings independently from click starts', () => {
    const state = new DesktopBehaviorState(0);
    state.recordClickStart({ ts: 0, x: 0, y: 0 });
    state.recordClickEnd(undefined); state.recordClickEnd({ ts: 0, x: 0, y: 0 });
    state.recordClickEnd({ ts: 16, x: 1, y: 1 }); state.recordClickEnd({ ts: 17, x: 2, y: 2 });
    expect(state.getSnapshot().clickEnds.map(point => point.ts)).toEqual([0, 17]);
    for (let i = 1; i <= 210; i++) state.recordClickEnd({ ts: 100 + i * 20, x: i, y: i });
    expect(state.getSnapshot().clickEnds).toHaveLength(200);
    expect(state.getSnapshot().clickEnds[0]?.ts).toBe(320);
    expect(state.getSnapshot().clickStarts).toHaveLength(1);
  });

  it('starts visibility empty, deduplicates by value, and treats non-visible states as 2', () => {
    const state = new DesktopBehaviorState(0);
    expect(state.getSnapshot().windowStates).toEqual([]);
    state.recordVisibility('visible', 1); state.recordVisibility('visible', 2);
    state.recordVisibility('hidden', 3); state.recordVisibility('prerender', 4);
    expect(state.getSnapshot().windowStates).toEqual([{ v: 1, ts: 1 }, { v: 2, ts: 3 }]);
    for (let i = 0; i < 60; i++) state.recordVisibility(i % 2 ? 'hidden' : 'visible', i);
    expect(state.getSnapshot().windowStates).toHaveLength(50);
    expect(state.getSnapshot().windowStates[0]?.ts).toBe(10);
  });

  it('short mouseout removes the oldest hover, not the newest or the matching target', () => {
    const state = new DesktopBehaviorState(0);
    state.recordHover(undefined); state.recordHover({ target: 'unpaired', ts: 0, mode: 0 });
    expect(state.getSnapshot().focus).toEqual([]);
    state.recordHover({ target: 'oldest', ts: 100, mode: 1 });
    state.recordHover({ target: 'newest', ts: 200, mode: 1 });
    state.recordHover({ target: 'different', ts: 549, mode: 0 });
    expect(state.getSnapshot().focus.map(x => x.target)).toEqual(['newest']);
    state.recordHover({ target: 'different', ts: 550, mode: 0 });
    expect(state.getSnapshot().focus.map(x => x.mode)).toEqual([1, 0]);
  });

  it('retains only the latest 50 hover and orientation records', () => {
    const state = new DesktopBehaviorState(0);
    for (let i = 0; i < 60; i++) {
      state.recordHover({ target: `${i}`, ts: i, mode: 1 });
      state.recordOrientation({ x: 1, y: 2, z: 3, ts: i * 150000 }, () => .5);
    }
    expect(state.getSnapshot().focus).toHaveLength(50); expect(state.getSnapshot().focus[0]?.ts).toBe(10);
    expect(state.getSnapshot().orientations).toHaveLength(50); expect(state.getSnapshot().orientations[0]?.ts).toBe(1500000);
    expect(state.mask()).toBe(14);
  });

  it('draws orientation randomness only after all axes pass, including rejected time samples', () => {
    const state = new DesktopBehaviorState(0); let draws = 0;
    const random = () => { draws++; return .5; };
    state.recordOrientation({ x: 0, y: 1, z: 1, ts: 0 }, random);
    state.recordOrientation({ x: 1, y: NaN, z: 1, ts: 0 }, random);
    expect(draws).toBe(0);
    for (const ts of [0, 104999, 105000, 104000]) state.recordOrientation({ x: 1, y: 2, z: 3, ts }, random);
    expect(draws).toBe(4); expect(state.getSnapshot().orientations.map(x => x.ts)).toEqual([0, 105000]);
  });

  it('uses a fresh orientation threshold each time, not a cached delay', () => {
    const state = new DesktopBehaviorState(0);
    state.recordOrientation({ x: 1, y: 2, z: 3, ts: 0 }, () => .99);
    state.recordOrientation({ x: 1, y: 2, z: 3, ts: 60000 }, () => 0);
    expect(state.getSnapshot().orientations.map(x => x.ts)).toEqual([0, 60000]);
  });

  it('exposes non-consuming live report views of the same q queues', () => {
    const state = new DesktopBehaviorState(0), sources = state.createReportSources(() => ({ screen: 'fixture' }));
    const before = sources.move.data(); expect(before).toEqual([]);
    state.recordMove({ x: 0, y: 0, ts: 1 }); state.recordClickStart({ x: 0, y: 0, ts: 1 }); state.recordKeydown(1);
    const report = sources.move.data(); expect(state.mask()).toBe(0);
    state.recordMove({ x: 1000, y: 0, ts: 21 }); expect(state.mask()).toBe(16);
    expect(report).toEqual([{ x: 0, y: 0, ts: 1 }]); expect(before).toEqual([]);
    expect(sources.move.data()).toEqual(state.getSnapshot().moves);
    expect(sources.move.data()).toEqual(state.getSnapshot().moves);
    expect(state.mask(2)).toBe(0); expect(state.mask()).toBe(16);
  });

  it('copies caller-owned report-only samples and isolates contexts', () => {
    const state = new DesktopBehaviorState(0), other = new DesktopBehaviorState(0);
    const hover = { target: 'original', mode: 1 as const, ts: 1 }, orientation = { x: 1, y: 2, z: 3, ts: 1 };
    state.recordHover(hover); state.recordOrientation(orientation, () => .5);
    hover.target = 'changed'; orientation.z = 999;
    expect(state.getSnapshot().focus[0]?.target).toBe('original'); expect(state.getSnapshot().orientations[0]?.z).toBe(3);
    expect(other.getSnapshot().focus).toEqual([]); expect(other.getSnapshot().orientations).toEqual([]);
  });
});
