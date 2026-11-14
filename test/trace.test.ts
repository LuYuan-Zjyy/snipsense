import { describe, expect, it } from 'vitest';
import { parseChromeTrace } from '../src/core/trace';

describe('parseChromeTrace', () => {
  it('builds a nested call tree from complete events', () => {
    const trace = parseChromeTrace(
      {
        traceEvents: [
          {
            name: 'main',
            ph: 'X',
            ts: 0,
            dur: 100_000,
            pid: 1,
            tid: 1,
            args: { file: 'train.py', line: 10 },
          },
          {
            name: 'build_model',
            ph: 'X',
            ts: 10_000,
            dur: 30_000,
            pid: 1,
            tid: 1,
            args: { file: 'model.py', line: 20 },
          },
          {
            name: 'forward',
            ph: 'X',
            ts: 50_000,
            dur: 40_000,
            pid: 1,
            tid: 1,
            args: { file: 'model.py', line: 30 },
          },
        ],
      },
      'trace.json',
    );

    expect(trace.totalEvents).toBe(3);
    expect(trace.durationMs).toBe(100);
    expect(trace.roots).toHaveLength(1);
    expect(trace.roots[0]?.name).toBe('main');
    expect(trace.roots[0]?.children.map((child) => child.name)).toEqual(['build_model', 'forward']);
    expect(trace.roots[0]?.children[0]?.file).toBe('model.py');
    expect(trace.roots[0]?.children[0]?.line).toBe(20);
    expect(trace.slowest[0]?.name).toBe('main');
  });

  it('supports begin/end events and thread separation', () => {
    const trace = parseChromeTrace({
      traceEvents: [
        { name: 'main', ph: 'B', ts: 0, pid: 1, tid: 1 },
        { name: 'load', ph: 'B', ts: 100, pid: 1, tid: 1 },
        { name: 'load', ph: 'E', ts: 300, pid: 1, tid: 1 },
        { name: 'main', ph: 'E', ts: 1000, pid: 1, tid: 1 },
        { name: 'worker', ph: 'X', ts: 0, dur: 200, pid: 2, tid: 2 },
      ],
    });

    expect(trace.totalEvents).toBe(3);
    expect(trace.threads.length).toBeGreaterThanOrEqual(1);
    expect(trace.roots[0]?.name).toBe('main');
    expect(trace.roots[0]?.children[0]?.name).toBe('load');
    expect(trace.roots[0]?.children[0]?.durationMs).toBeCloseTo(0.2, 5);
  });

  it('extracts VizTracer source locations from event names', () => {
    const trace = parseChromeTrace({
      traceEvents: [
        {
          name: 'fib (/home/me/project/example.py:6)',
          ph: 'X',
          ts: 0,
          dur: 5,
          pid: 1,
          tid: 1,
          args: { func_args: { n: '6' }, return_value: '13' },
        },
      ],
    });
    expect(trace.roots[0]?.name).toBe('fib');
    expect(trace.roots[0]?.file).toBe('/home/me/project/example.py');
    expect(trace.roots[0]?.line).toBe(6);
  });

  it('reads Chrome trace metadata and rejects invalid input', () => {
    expect(() => parseChromeTrace({})).toThrow(/trace/i);
    const trace = parseChromeTrace([
      {
        name: 'step',
        ph: 'X',
        ts: 0,
        dur: 500,
        args: { filename: 'src/train.py', lineno: 42 },
      },
    ]);
    expect(trace.roots[0]?.file).toBe('src/train.py');
    expect(trace.roots[0]?.line).toBe(42);
  });
});
