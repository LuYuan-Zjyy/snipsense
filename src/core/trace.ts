export interface TraceNode {
  id: number;
  name: string;
  file?: string;
  line?: number;
  startMs: number;
  durationMs: number;
  depth: number;
  category?: string;
  thread?: string;
  children: TraceNode[];
}

export interface TraceModel {
  fileName: string;
  totalEvents: number;
  durationMs: number;
  roots: TraceNode[];
  slowest: TraceNode[];
  threads: string[];
  truncated: boolean;
}

interface RawEvent {
  name: string;
  ts: number;
  dur: number;
  pid?: number | string;
  tid?: number | string;
  cat?: string;
  ph?: string;
  args?: Record<string, unknown>;
}

interface Interval {
  name: string;
  start: number;
  end: number;
  pid: string;
  tid: string;
  category?: string;
  args?: Record<string, unknown>;
}

const MAX_EVENTS = 8000;
const MAX_ROWS = 4000;

export function parseChromeTrace(input: unknown, fileName = 'trace.json'): TraceModel {
  const events = readEvents(input);
  if (!events) throw new Error('无法识别这个 trace 文件：缺少 traceEvents 数组。');

  const intervals = eventsToIntervals(events);
  const totalEvents = intervals.length;
  const selected = intervals.slice(0, MAX_EVENTS);
  const truncated = totalEvents > MAX_EVENTS;
  const rootsByThread = new Map<string, TraceNode[]>();
  const nodeStacks = new Map<string, TraceNode[]>();
  const slowest: TraceNode[] = [];
  let nodeId = 0;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;

  for (const interval of selected.sort(
    (left, right) => left.start - right.start || right.end - right.start,
  )) {
    minStart = Math.min(minStart, interval.start);
    maxEnd = Math.max(maxEnd, interval.end);
    const thread = `${interval.pid}:${interval.tid}`;
    const nodeStack = nodeStacks.get(thread) ?? [];
    while (nodeStack.length > 0) {
      const top = nodeStack[nodeStack.length - 1] as TraceNode;
      if (top.startMs + top.durationMs > interval.start) break;
      nodeStack.pop();
    }

    const parsedName = parseName(interval.name);
    const node: TraceNode = {
      id: nodeId++,
      name: parsedName.name,
      file: parsedName.file ?? fileFromArgs(interval.args),
      line: parsedName.line ?? lineFromArgs(interval.args),
      startMs: interval.start,
      durationMs: Math.max(0, interval.end - interval.start),
      depth: Math.min(nodeStack.length, 12),
      category: interval.category,
      thread,
      children: [],
    };

    const parentNode = nodeStack[nodeStack.length - 1];
    if (parentNode) parentNode.children.push(node);
    else {
      const roots = rootsByThread.get(thread) ?? [];
      roots.push(node);
      rootsByThread.set(thread, roots);
    }
    nodeStack.push(node);
    nodeStacks.set(thread, nodeStack);
    if (nodeStack.length > 24) nodeStack.splice(0, nodeStack.length - 24);

    if (slowest.length < 12 || node.durationMs > (slowest[slowest.length - 1]?.durationMs ?? 0)) {
      slowest.push(node);
      slowest.sort((left, right) => right.durationMs - left.durationMs);
      if (slowest.length > 12) slowest.pop();
    }
  }

  const threads = [...rootsByThread.keys()];
  const primaryThread = threads.sort(
    (left, right) =>
      (rootsByThread.get(right)?.length ?? 0) - (rootsByThread.get(left)?.length ?? 0),
  )[0];
  const roots = primaryThread ? (rootsByThread.get(primaryThread) ?? []) : [];
  const durationMs = Number.isFinite(minStart) ? Math.max(0, maxEnd - minStart) : 0;

  return {
    fileName,
    totalEvents,
    durationMs,
    roots,
    slowest,
    threads,
    truncated: truncated || totalEvents > MAX_ROWS,
  };
}

function readEvents(input: unknown): RawEvent[] | undefined {
  const candidate = Array.isArray(input)
    ? input
    : input && typeof input === 'object'
      ? ((input as { traceEvents?: unknown; events?: unknown }).traceEvents ??
        (input as { events?: unknown }).events)
      : undefined;
  if (!Array.isArray(candidate)) return undefined;

  return candidate.filter((event): event is RawEvent => {
    if (!event || typeof event !== 'object') return false;
    const value = event as RawEvent;
    return typeof value.name === 'string' && typeof value.ts === 'number';
  });
}

function eventsToIntervals(events: RawEvent[]): Interval[] {
  const intervals: Interval[] = [];
  const open = new Map<
    string,
    Array<{
      name: string;
      start: number;
      pid: string;
      tid: string;
      cat?: string;
      args?: Record<string, unknown>;
    }>
  >();

  for (const event of events) {
    const pid = String(event.pid ?? 0);
    const tid = String(event.tid ?? 0);
    const thread = `${pid}:${tid}`;

    if (event.ph === 'B') {
      const stack = open.get(thread) ?? [];
      stack.push({
        name: event.name,
        start: event.ts,
        pid,
        tid,
        cat: event.cat,
        args: event.args,
      });
      open.set(thread, stack);
      continue;
    }

    if (event.ph === 'E') {
      const stack = open.get(thread) ?? [];
      const start = stack.pop();
      if (start) {
        intervals.push({
          name: start.name,
          start: start.start / 1000,
          end: event.ts / 1000,
          pid,
          tid,
          category: start.cat,
          args: start.args,
        });
      }
      continue;
    }

    if (event.ph !== 'X' && event.ph !== undefined) continue;
    if (typeof event.dur !== 'number' || event.dur < 0) continue;
    intervals.push({
      name: event.name,
      start: event.ts / 1000,
      end: (event.ts + event.dur) / 1000,
      pid,
      tid,
      category: event.cat,
      args: event.args,
    });
  }

  for (const stack of open.values()) {
    for (const start of stack) {
      // Unclosed B events are still useful as zero-duration points.
      intervals.push({
        name: start.name,
        start: start.start / 1000,
        end: start.start / 1000,
        pid: start.pid,
        tid: start.tid,
      });
    }
  }

  return intervals;
}

function fileFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['file', 'filename', 'path', 'source']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return cleanPath(value);
  }
  const stack = args.stack;
  if (Array.isArray(stack)) {
    for (const frame of stack) {
      if (typeof frame === 'string') {
        const match = frame.match(/([^()\s]+\.(?:py|ts|tsx|js|jsx|java|go|rs)):(\d+)/);
        if (match?.[1]) return cleanPath(match[1]);
      }
    }
  }
  return undefined;
}

function lineFromArgs(args: Record<string, unknown> | undefined): number | undefined {
  if (!args) return undefined;
  for (const key of ['line', 'lineno']) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function parseName(raw: string): { name: string; file?: string; line?: number } {
  // VizTracer encodes the source location in the event name:
  // "fib (/path/to/function_args_return.py:6)".
  const match = raw.match(/^(.*?)\s+\((.+):(\d+)\)\s*$/);
  if (match?.[1] && match[2] && match[3]) {
    return {
      name: cleanName(match[1]),
      file: cleanPath(match[2]),
      line: Number(match[3]),
    };
  }
  return { name: cleanName(raw) };
}

function cleanPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
