import { validateSnapshot } from './contract.mjs';

export function classifySnapshot(snapshot, now = new Date()) {
  const nowMs = now.getTime();
  const expiresAt = Date.parse(snapshot.expiresAt);
  const discardAfter = Date.parse(snapshot.discardAfter);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAt) || !Number.isFinite(discardAfter)) {
    return { kind: 'timetable-only', reason: 'semantic-invalid-response' };
  }
  if (nowMs > discardAfter) return { kind: 'timetable-only', reason: 'live-expired' };
  if (snapshot.status === 'unavailable' || snapshot.fallback.mode === 'timetable-only') {
    return { kind: 'timetable-only', reason: snapshot.fallback.reason || 'live-unavailable' };
  }
  if (nowMs > expiresAt || snapshot.status === 'degraded'
      || snapshot.vehicles.some(({ dataStatus }) => dataStatus === 'stale')) {
    return { kind: 'stale', reason: nowMs > expiresAt ? 'live-expired' : 'source-degraded' };
  }
  return { kind: 'fresh', reason: null };
}

export function markerModel(vehicle) {
  if (vehicle.positionKind === 'none' || vehicle.position === null) return null;
  return {
    id: vehicle.id,
    lat: vehicle.position.lat,
    lon: vehicle.position.lon,
    mode: vehicle.mode,
    label: vehicle.label,
    style: vehicle.positionKind === 'reported' ? 'reported' : 'estimated',
    stale: vehicle.dataStatus === 'stale',
  };
}

export class LivePositionsClient {
  constructor({
    url,
    intervalMs = 60_000,
    onSnapshot = () => {},
    onState = () => {},
    fetchImpl = globalThis.fetch,
  }) {
    if (!url) throw new TypeError('url is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');
    this.url = url;
    this.intervalMs = intervalMs;
    this.onSnapshot = onSnapshot;
    this.onState = onState;
    this.fetchImpl = fetchImpl;
    this.etag = null;
    this.lastSnapshot = null;
    this.controller = null;
    this.timer = null;
    this.started = false;
    this.handleVisibility = () => {
      if (!globalThis.document?.hidden) this.poll();
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    globalThis.document?.addEventListener('visibilitychange', this.handleVisibility);
    this.poll();
  }

  stop() {
    this.started = false;
    this.controller?.abort();
    globalThis.clearTimeout(this.timer);
    globalThis.document?.removeEventListener('visibilitychange', this.handleVisibility);
  }

  scheduleNext() {
    globalThis.clearTimeout(this.timer);
    if (!this.started) return;
    const jitter = Math.round(this.intervalMs * (Math.random() * 0.1));
    this.timer = globalThis.setTimeout(() => this.poll(), this.intervalMs + jitter);
  }

  preserveOrFallback(reason) {
    if (this.lastSnapshot) {
      const state = classifySnapshot(this.lastSnapshot);
      if (state.kind !== 'timetable-only') {
        this.onState({ kind: 'stale', reason });
        return;
      }
    }
    this.onState({ kind: 'timetable-only', reason });
  }

  async poll() {
    if (!this.started || globalThis.document?.hidden) return;
    this.controller?.abort();
    this.controller = new AbortController();
    try {
      const headers = this.etag ? { 'If-None-Match': this.etag } : undefined;
      const response = await this.fetchImpl(this.url, {
        headers,
        cache: 'no-store',
        signal: this.controller.signal,
      });
      if (response.status === 304) {
        if (this.lastSnapshot) this.onState(classifySnapshot(this.lastSnapshot));
        return;
      }
      if (!response.ok) {
        this.preserveOrFallback('live-unavailable');
        return;
      }
      const candidate = await response.json();
      const validation = validateSnapshot(candidate);
      if (!validation.ok) {
        this.preserveOrFallback('semantic-invalid-response');
        return;
      }
      this.etag = response.headers.get('etag') || this.etag;
      this.lastSnapshot = candidate;
      const state = classifySnapshot(candidate);
      this.onSnapshot({
        snapshot: candidate,
        markers: candidate.vehicles.map(markerModel).filter(Boolean),
        activeWithoutPosition: candidate.vehicles.filter(({ status, positionKind }) => (
          status === 'active' && positionKind === 'none'
        )),
      });
      this.onState(state);
    } catch (error) {
      if (error?.name !== 'AbortError') this.preserveOrFallback('live-unavailable');
    } finally {
      this.scheduleNext();
    }
  }
}
