export async function fetchWithTimeout(url, options = {}, timeoutMs = 9_000) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', 'User-Agent': 'SolarisPKN-Transport-Live/2.0', ...(options.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${new URL(url).hostname}`);
  return response;
}

export async function fetchJson(url, options, timeoutMs) {
  return (await fetchWithTimeout(url, options, timeoutMs)).json();
}

export function safeError(error) {
  return String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 180);
}
