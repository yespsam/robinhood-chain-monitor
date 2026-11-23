// Display-only status from the process that owns automatic live execution.
// Do not infer execution from this mobile server's startup environment.
export async function readLiveRuntimeStatus({ fetchImpl = fetch, port = 4173, timeoutMs = 3000 } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/live-runtime-status`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      // This compact local endpoint needs no compression.
      headers: { 'accept-encoding': 'identity' },
    });
    if (!response.ok) throw new Error('runtime_unavailable');
    const runtime = await response.json();
    const mirror = runtime?.liveMirror;
    if (typeof mirror?.enabled !== 'boolean') throw new Error('runtime_status_missing');
    return {
      status: 'available',
      enabled: mirror.enabled,
      chains: Array.isArray(mirror.chains) ? mirror.chains.join(',') : '',
      paperEnabled: typeof runtime.enabled === 'boolean' ? runtime.enabled : null,
      runtimeStatus: typeof runtime.status === 'string' ? runtime.status : null,
      updatedAt: runtime.updatedAt || null,
    };
  } catch {
    return { status: 'unavailable', enabled: null, chains: '', paperEnabled: null, runtimeStatus: null, updatedAt: null };
  }
}
