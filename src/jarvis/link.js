/**
 * The JARVIS link.
 *
 * Opt-in: open the app with `?jarvis=1` (or build with VITE_JARVIS_BRIDGE_URL).
 * When on, this page becomes JARVIS's view of the world. The JARVIS bridge
 * sends tool calls over a WebSocket; they run through the same action runner
 * GEV's own voice agent uses, and the results go back — along with a fresh
 * viewport frame when JARVIS asks to look.
 *
 * The socket is an executor, not a conversation. It answers `run`, `look` and
 * `cancel` and nothing else, so nothing on this page can start a turn on the
 * JARVIS side.
 */

const DEFAULT_BRIDGE_URL = 'ws://localhost:8787/world';
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
const MAX_ERROR_CHARS = 240;
/** Close code the bridge uses when a newer page takes over the link. */
const REPLACED_CODE = 4000;
/**
 * GEV's own cap (200 KB) exists for the OpenAI data channel, and a sharp city
 * frame routinely exceeds it — every capture came back empty under it. The
 * bridge socket has no such limit, so frames up to this size go through.
 */
const MAX_FRAME_BYTES = 1_500_000;

/** True when this page was opened as JARVIS's world view. */
export function jarvisLinkRequested(search = window.location.search) {
  if (new URLSearchParams(search).get('jarvis') === '1') return true;
  return Boolean(import.meta.env?.VITE_JARVIS_BRIDGE_URL);
}

function bridgeUrl() {
  return import.meta.env?.VITE_JARVIS_BRIDGE_URL || DEFAULT_BRIDGE_URL;
}

/**
 * Results cross a socket as JSON. The voice agent already stringifies them, so
 * they are serializable by contract — but one that is not must come back as a
 * failure the model can read, not a dropped reply that hangs the turn.
 */
function serializable(value, action) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return { ok: false, action, error: 'Result could not be serialized' };
  }
}

/**
 * @param {object} options
 * @param {(name: string, args: object, runOptions?: object) => Promise<object>} options.runner
 *   The voice agent's action runner.
 * @param {(options?: { maxEncodedBytes?: number }) => Promise<string|null>} options.captureViewport
 *   Resolves a JPEG data URL of a fresh frame, or null (hidden, black, too big).
 * @returns {() => void} stop
 */
export function startJarvisLink({ runner, captureViewport }) {
  let socket = null;
  let retryMs = RETRY_MIN_MS;
  let retryTimer = null;
  let stopped = false;
  const inFlight = new Map();
  const chip = createChip();

  const send = (msg) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  };

  async function run(id, name, args) {
    const controller = new AbortController();
    inFlight.set(id, controller);
    let result;
    try {
      result = await runner(
        name,
        args && typeof args === 'object' ? args : {},
        {
          signal: controller.signal,
        },
      );
    } catch (error) {
      result = {
        ok: false,
        action: name,
        error: String(error?.message || error).slice(0, MAX_ERROR_CHARS),
      };
    } finally {
      inFlight.delete(id);
    }
    send({ type: 'result', id, result: serializable(result, name) });
  }

  async function look(id) {
    let context;
    try {
      context = await runner('get_entity_context', { scope: 'auto' });
    } catch (error) {
      context = {
        ok: false,
        action: 'get_entity_context',
        error: String(error?.message || error).slice(0, MAX_ERROR_CHARS),
      };
    }
    // A hidden tab renders nothing, and captureViewport refuses to pass a
    // stale frame off as current — so say hidden rather than send nothing.
    let image = null;
    if (!document.hidden) {
      try {
        image = await captureViewport({ maxEncodedBytes: MAX_FRAME_BYTES });
      } catch {
        image = null;
      }
    }
    send({
      type: 'look',
      id,
      hidden: document.hidden,
      image: image ? image.slice(image.indexOf(',') + 1) : null,
      mimeType: 'image/jpeg',
      context: serializable(context, 'get_entity_context'),
    });
  }

  const onMessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.id !== 'string') return;
    if (msg.type === 'run' && typeof msg.name === 'string') {
      void run(msg.id, msg.name, msg.args);
    } else if (msg.type === 'look') {
      void look(msg.id);
    } else if (msg.type === 'cancel') {
      inFlight.get(msg.id)?.abort();
    }
  };

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  function connect() {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocket(bridgeUrl());
    } catch {
      scheduleRetry();
      return;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      retryMs = RETRY_MIN_MS;
      setChip(chip, 'online');
      send({ type: 'hello', app: 'gods-eye-view', protocol: 1 });
    });
    ws.addEventListener('message', onMessage);
    // An error is always followed by close, so close alone drives the retry.
    ws.addEventListener('close', (event) => {
      if (socket === ws) socket = null;
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
      // The bridge handed the link to a newer page. Reconnecting would take it
      // back, and two open tabs would trade it forever.
      if (event.code === REPLACED_CODE) {
        stopped = true;
        setChip(chip, 'replaced');
        return;
      }
      setChip(chip, 'searching');
      scheduleRetry();
    });
  }

  connect();

  return function stop() {
    stopped = true;
    clearTimeout(retryTimer);
    retryTimer = null;
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    socket = null;
    chip.remove();
  };
}

const CHIP_STATES = {
  online: { text: 'JARVIS LINK · ONLINE', color: '#00e5ff' },
  searching: { text: 'JARVIS LINK · SEARCHING', color: '#f0a63c' },
  replaced: { text: 'JARVIS LINK · IN ANOTHER TAB', color: '#8a9aa0' },
};

function createChip() {
  const chip = document.createElement('div');
  chip.id = 'gev-jarvis-link';
  chip.setAttribute('role', 'status');
  Object.assign(chip.style, {
    position: 'fixed',
    top: '10px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '10000',
    pointerEvents: 'none',
    font: '600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace',
    letterSpacing: '0.18em',
    padding: '6px 9px',
    border: '1px solid currentColor',
    background: 'rgba(2, 10, 12, 0.72)',
  });
  document.body.appendChild(chip);
  setChip(chip, 'searching');
  return chip;
}

function setChip(chip, state) {
  const { text, color } = CHIP_STATES[state] ?? CHIP_STATES.searching;
  chip.textContent = text;
  chip.style.color = color;
}
