/**
 * dsh-battlefield — Host half.
 *
 * The whole feature lives in the browser module (`client.js`): it observes key
 * events, keeps the statistics and paints the floating HUD. Nothing needs the
 * Host, no file is touched and no network request leaves the machine.
 *
 * What the Host does provide is a single read-only health route, because the
 * client bundle gives no way to tell from the outside whether the plugin really
 * loaded — a client module that fails to load is silent. `GET
 * /api/dsh-battlefield/health` answering with the version is therefore the only
 * honest proof that this row is live.
 *
 * The gunshot samples are inlined in the client bundle as base64, so the sound
 * needs no Host route and no restart: the browser half alone can play it.
 */

export const name = 'dsh-battlefield';

export const inject = [];

const VERSION = '0.15.1';
const PREFIX = '/api/dsh-battlefield';
const STARTED_AT = Date.now();

/**
 * Refuse cross-site and off-origin callers. The route reads nothing, but a
 * plugin must not become a way for another page to fingerprint the machine.
 */
function requestAllowed(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  let host;
  try {
    host = new URL(`http://${request.headers.host}`);
  } catch {
    return false;
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host.host) return false;
    } catch {
      return false;
    }
  }
  // 只对本机开放：插件的路由不该成为同一局域网里其他机器的指纹来源。
  const remote = request.socket?.remoteAddress;
  if (typeof remote === 'string' && remote.length > 0) {
    return remote === '::1' || remote === '::ffff:127.0.0.1' || remote.startsWith('127.');
  }
  const hostname = host.hostname;
  return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

export function apply(ctx) {
  // `webServer` is optional: if the Host has no HTTP layer the plugin still
  // loads, the HUD still works, only the health route is absent.
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(
        () => {
          const offMount = scoped.webServer.register({
            kind: 'exact',
            path: `${PREFIX}/mount`,
            handler: (request, response) => {
              if (!requestAllowed(request)) {
                return sendJson(response, 403, { ok: false, text: 'forbidden' });
              }
              if (request.method !== 'GET' && request.method !== 'HEAD') {
                return sendJson(response, 405, { ok: false, text: 'method not allowed' });
              }
              mounts += 1;
              lastMountAt = Date.now();
              return sendJson(response, 200, { ok: true, mounts });
            },
          });
          const off = scoped.webServer.register({
            kind: 'exact',
            path: `${PREFIX}/health`,
            handler: (request, response) => {
              if (!requestAllowed(request)) {
                return sendJson(response, 403, { ok: false, text: 'forbidden' });
              }
              if (request.method !== 'GET' && request.method !== 'HEAD') {
                return sendJson(response, 405, { ok: false, text: 'method not allowed' });
              }
              return sendJson(response, 200, {
                ok: true,
                name,
                version: VERSION,
                uptimeMs: Date.now() - STARTED_AT,
                mounts,
                lastMountAt,
                client: 'floating HUD, mounted into document.body by the browser half',
                captures: 'physical key codes and timestamps only — never the typed character',
              });
            },
          });
          return () => {
            if (typeof off === 'function') off();
            if (typeof offMount === 'function') offMount();
          };
        },
        'dsh-battlefield: health route',
      );
    });
  } catch (error) {
    // A missing service must never take the plugin down.
    console.warn(`[dsh-battlefield] health route not registered: ${error?.message ?? error}`);
  }
}
