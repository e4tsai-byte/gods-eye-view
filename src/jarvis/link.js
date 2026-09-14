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
 *
 * Embedded (`&embed=<JARVIS origin>`, inside JARVIS's own page), the chip and
 * GEV's title and style readout step aside for JARVIS's HUD, and the page tells
 * its parent about keys and activity it would otherwise swallow.
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
/** Keys JARVIS owns even while the globe has focus: talk, type, layout. */
const PARENT_KEYS = new Set([' ', 'Enter', 'w']);
/** Pointer and wheel activity is reported at most this often. */
const ACTIVITY_THROTTLE_MS = 1500;

/** True when this page was opened as JARVIS's world view. */
export function jarvisLinkRequested(search = window.location.search) {
  if (new URLSearchParams(search).get('jarvis') === '1') return true;
  return Boolean(import.meta.env?.VITE_JARVIS_BRIDGE_URL);
}

/**
 * The JARVIS page embedding this one, as an origin — or null when not
 * embedded. Messages only ever go to exactly this origin.
 */
export function embeddingOrigin(search = window.location.search) {
  const raw = new URLSearchParams(search).get('embed');
  if (!raw || window.parent === window) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
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

function isEditable(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) {
    return true;
  }
  return false;
}

/**
 * Embedded mode. GEV's title block and style readout would sit under JARVIS's
 * orb and brand, so they step aside. Space, Enter and W are passed up while the
 * globe has focus — otherwise clicking the map would silently take JARVIS's
 * talk and type keys away — and pointer or wheel activity is reported so
 * JARVIS does not pull the view away from someone in the middle of using it.
 */
function startEmbedded(parentOrigin, setPanelView) {
  // JARVIS says which view the globe is in: the bare globe in a dashboard
  // panel, or GEV's full interface on the whole screen.
  let panel = false;
  const apply = (want) => {
    try {
      setPanelView?.(want);
    } catch {
      /* the view stays as it is */
    }
  };
  const onParent = (event) => {
    if (event.origin !== parentOrigin || event.source !== window.parent) return;
    const msg = event.data;
    if (msg?.source !== 'jarvis' || msg.type !== 'layout') return;
    panel = msg.layout === 'dash';
    apply(panel);
  };
  window.addEventListener('message', onParent);

  // The panel view is held, not just set. GEV's own startup can re-apply its
  // interface after JARVIS has asked for the bare globe, which left the panel
  // full of chrome on some boots; while the globe sits in the dash, anything
  // that takes clean view off puts it straight back.
  const guard = new MutationObserver(() => {
    if (panel && !document.body.classList.contains('ui-clean-view')) {
      apply(true);
    }
  });
  guard.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  // A stylesheet rather than element lookups: GEV builds its HUD corners
  // after startup, and a rule reaches them whenever they appear. JARVIS's orb
  // and conversation card own the right-hand corners. display rather than
  // visibility, because the REC dot blinks by setting its own visibility,
  // which would show through a hidden parent. Clean view's exit button goes
  // too: JARVIS switches clean view with its layout, and a click on it inside
  // the dash panel would put GEV's chrome back in a box too small for it.
  const style = document.createElement('style');
  style.textContent =
    '#title-bar, #style-indicator, .hud-top-right, .hud-bottom-right,' +
    ' #clean-view-exit { display: none !important; }';
  document.head.appendChild(style);

  const post = (msg) => {
    try {
      window.parent.postMessage({ source: 'gev', ...msg }, parentOrigin);
    } catch {
      /* parent gone */
    }
  };

  // Ask for the layout now that something is listening for it. JARVIS also
  // sends it on the frame's load and whenever the link changes, but GEV only
  // gets here after its own async startup, so either of those can land before
  // the listener exists — and a lost message left the dash panel full of
  // GEV's chrome.
  post({ type: 'ready' });

  const onKey = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (!PARENT_KEYS.has(event.key) || isEditable(event.target)) return;
    // A focused control keeps its own Space and Enter.
    if (event.target instanceof Element && event.target.closest('button, a')) {
      return;
    }
    event.preventDefault();
    post({
      type: event.type === 'keyup' ? 'keyup' : 'key',
      key: event.key,
      code: event.code,
    });
  };

  let lastActivity = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastActivity < ACTIVITY_THROTTLE_MS) return;
    lastActivity = now;
    post({ type: 'activity' });
  };

  window.addEventListener('keydown', onKey, true);
  // Releases too: JARVIS is hold-to-talk, so a Space release swallowed here
  // would leave his microphone open.
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('pointerdown', onActivity, true);
  window.addEventListener('wheel', onActivity, {
    capture: true,
    passive: true,
  });

  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('pointerdown', onActivity, true);
    window.removeEventListener('wheel', onActivity, { capture: true });
    style.remove();
    guard.disconnect();
    window.removeEventListener('message', onParent);
  };
}

/**
 * @param {object} options
 * @param {(name: string, args: object, runOptions?: object) => Promise<object>} options.runner
 *   The voice agent's action runner.
 * @param {(options?: { maxEncodedBytes?: number }) => Promise<string|null>} options.captureViewport
 *   Resolves a JPEG data URL of a fresh frame, or null (hidden, black, too big).
 * @returns {() => void} stop
 */
export function startJarvisLink({ runner, captureViewport, setPanelView }) {
  let socket = null;
  let retryMs = RETRY_MIN_MS;
  let retryTimer = null;
  let stopped = false;
  const inFlight = new Map();
  const parentOrigin = embeddingOrigin();
  // Embedded, JARVIS's own HUD shows the link state, so no chip.
  const chip = parentOrigin ? null : createChip();
  const stopEmbedded = parentOrigin
    ? startEmbedded(parentOrigin, setPanelView)
    : null;

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
      // `embedded` lets the bridge prefer the globe inside JARVIS's own tab
      // over a standalone window that also has the link open.
      send({
        type: 'hello',
        app: 'gods-eye-view',
        protocol: 1,
        embedded: Boolean(parentOrigin),
      });
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
    chip?.remove();
    stopEmbedded?.();
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
  if (!chip) return;
  const { text, color } = CHIP_STATES[state] ?? CHIP_STATES.searching;
  chip.textContent = text;
  chip.style.color = color;
}
