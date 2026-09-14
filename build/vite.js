import cesium from 'vite-plugin-cesium';

/**
 * These headers protect the document containing Provider Settings. By default
 * nothing may frame it. `frameAncestors` — a comma-separated list of exact
 * http(s) origins — lets those pages embed the app, e.g. a local assistant
 * showing the globe in its own window. X-Frame-Options cannot express an
 * allow-list, so it is dropped only when one is given; anything malformed
 * falls back to the default rather than widening it.
 */
export function frameHeaders(frameAncestors) {
  const allowed = String(frameAncestors ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const valid = allowed.every((origin) =>
    /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(origin),
  );
  if (!allowed.length || !valid) {
    return {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    };
  }
  return { 'Content-Security-Policy': `frame-ancestors ${allowed.join(' ')}` };
}

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
  frameAncestors,
} = {}) {
  return {
    plugins: [cesium(), ...plugins],
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      headers: frameHeaders(frameAncestors),
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
