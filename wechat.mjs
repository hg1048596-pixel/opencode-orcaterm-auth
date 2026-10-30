/**
 * WeChat QR sign-in for OrcaTerm.
 *
 * This uses OrcaTerm's own OAuth rather than the console session cookie:
 *
 *   GET  {OAUTH}/oauth/wechat/config   → {appid, redirect_uri, state, scope}
 *   →  the local page below embeds WeChat's qrconnect widget
 *   the scan returns to {redirect_uri} (/oauth/wechat/bridge?code&state), and that
 *   page postMessages the result to its parent — which is our page
 *   POST {OAUTH}/oauth/wechat/exchange  → {userId, accessToken, expiresIn, …}
 *   POST {CAPI}?action=OAuthRefreshToken → renews it
 *
 * Why `self_redirect: true` matters: after a scan, qrconnect navigates the *top*
 * window by default, which replaces the host page and loses the postMessage.
 * With it set, the return happens inside the widget's own inner iframe, so the
 * bridge page's `window.parent` is still our page.
 *
 * The token this yields is a 1024-character JWT, valid two hours and renewable.
 * Measured 2026-10-27: it drives /assistant/chat directly, namespaced model ids
 * included — and it is a far smaller credential than uin+skey, which is the whole
 * Tencent Cloud console session.
 */
import http from "node:http"
import os from "node:os"

export const OAUTH_BASE = "https://orcaterm.com"

const WECHAT_QRCONNECT = "https://open.weixin.qq.com/connect/qrconnect"

export class WechatLoginError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = "WechatLoginError"
    this.code = code
  }
}

const FRIENDLY = {
  STATE_EXPIRED: "The QR code expired (a WeChat code lasts about five minutes and works once). Scan again.",
  STATE_MISMATCH: "The state is no longer valid. Start the sign-in again.",
  INVALID_REQUEST: "WeChat's code was not accepted (it may already have been used). Scan again.",
  PROVIDER_DISABLED: "OrcaTerm has disabled WeChat sign-in.",
}

async function jsonFetch(url, init = {}, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { res, body, text }
  } finally {
    clearTimeout(t)
  }
}

/** Step 1: read appid/redirect_uri/state and build the scan URL. */
export async function startWechatLogin({ base = OAUTH_BASE } = {}) {
  const { res, body, text } = await jsonFetch(`${base}/oauth/wechat/config`, {
    headers: { accept: "application/json" },
  })
  const d = body?.data
  if (!res.ok || Number(body?.code) !== 0 || !d) {
    throw new WechatLoginError(
      String(body?.code ?? "INTERNAL_ERROR"),
      body?.message || text.slice(0, 120) || `[config] http ${res.status}`,
    )
  }
  if (!d.appid || !d.redirect_uri || !d.state || !d.scope) {
    throw new WechatLoginError("INTERNAL_ERROR", "[config] response is missing a field")
  }

  const qr = new URL(WECHAT_QRCONNECT)
  qr.searchParams.set("appid", d.appid)
  qr.searchParams.set("redirect_uri", d.redirect_uri)
  qr.searchParams.set("response_type", "code")
  qr.searchParams.set("scope", d.scope)
  qr.searchParams.set("state", d.state)

  return {
    appid: d.appid,
    redirectUri: d.redirect_uri,
    state: d.state,
    scope: d.scope,
    url: `${qr.toString()}#wechat_redirect`,
  }
}

/** Step 4: trade the code for a token. */
export async function exchangeCode({ code, state, base = OAUTH_BASE }) {
  const { res, body, text } = await jsonFetch(`${base}/oauth/wechat/exchange`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ code, state }),
  })
  const known = ["STATE_EXPIRED", "STATE_MISMATCH", "INVALID_REQUEST", "PROVIDER_DISABLED"]
  const c = String(body?.code ?? "")
  if (!res.ok || Number(body?.code) !== 0 || !body?.data) {
    const code2 = known.includes(c) ? c : "INTERNAL_ERROR"
    throw new WechatLoginError(
      code2,
      FRIENDLY[code2] || body?.message || text.slice(0, 160) || "WeChat sign-in failed",
    )
  }
  const d = body.data
  if (!d.accessToken) throw new WechatLoginError("INTERNAL_ERROR", "[exchange] no accessToken in the response")
  const userId = String(d.userId ?? "").trim() || readTokenClaims(d.accessToken).userId.trim()
  if (!userId) throw new WechatLoginError("INTERNAL_ERROR", "[exchange] no userId in the response or access token")
  const expiresIn = Number(d.expiresIn) || 0
  return {
    userId,
    nickname: d.providerUsername ?? "",
    avatar: d.avatar ?? "",
    accessToken: d.accessToken,
    expiresIn,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
  }
}

/** Renew: trade the current token for a fresh one (same two-hour life). */
export async function refreshAccessToken(token, { base = OAUTH_BASE } = {}) {
  const { body, text } = await jsonFetch(
    `${base}/cgi/api?action=OAuthRefreshToken`,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ action: "OAuthRefreshToken", data: { accessToken: token } }),
    },
    15000,
  )
  const r = body?.data?.Response ?? body?.data
  const next = r?.accessToken ?? r?.AccessToken
  if (!next) {
    throw new WechatLoginError("INTERNAL_ERROR", `renewal failed: ${(r?.Error?.Message || text).slice(0, 120)}`)
  }
  const expiresIn = Number(r?.expiresIn ?? r?.ExpiresIn) || 0
  return { accessToken: next, expiresIn, expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null }
}

/** Read userId/nickname/expiry out of the JWT (no signature check). */
export function readTokenClaims(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"))
    return {
      userId: p?.userId != null ? String(p.userId) : "",
      nickname: p?.providerUsername ?? "",
      exp: Number(p?.exp) || 0,
    }
  } catch {
    return { userId: "", nickname: "", exp: 0 }
  }
}

/** True for something shaped like a WeChat OAuth access token (a JWT). */
export function looksLikeAccessToken(s) {
  return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(String(s ?? "").trim())
}

const PAGE = ({ appid, redirectUri, state, bridgeOrigin }) => `<!doctype html>
<html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OrcaTerm · WeChat sign-in</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d10;color:#e6e6e6;
    font:14px/1.6 -apple-system,system-ui,"PingFang SC",sans-serif}
  #wrap{display:flex;align-items:center;justify-content:center;height:100%}
  #done{display:none;align-items:center;justify-content:center;height:100%;text-align:center;padding:24px}
  .err{color:#ff8a8a}
</style>
<div id="wrap"><div id="wxqr"></div></div>
<div id="done"></div>
<script src="https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js"></script>
<script>
  const APPID = ${JSON.stringify(appid)};
  const REDIRECT = ${JSON.stringify(redirectUri)};
  const STATE = ${JSON.stringify(state)};

  // self_redirect: true keeps the return inside the widget's own iframe, so the
  // host page (this one) survives to receive the postMessage.
  new WxLogin({
    self_redirect: true,
    id: 'wxqr',
    appid: APPID,
    scope: 'snsapi_login',
    redirect_uri: encodeURIComponent(REDIRECT),
    state: STATE,
    style: 'black',
    href: '',
  });

  function done(text, isErr) {
    document.getElementById('wrap').style.display = 'none';
    const d = document.getElementById('done');
    d.className = isErr ? 'err' : '';
    d.textContent = text;
    d.style.display = 'flex';
  }

  // Only the bridge page this sign-in is talking to may answer it. Without the
  // origin check any window that has a handle on this one could post a code.
  // Taken from the redirect_uri OrcaTerm itself issued, so a move of the bridge
  // to another host does not silently stall every scan.
  const TRUSTED_ORIGIN = ${JSON.stringify(bridgeOrigin)};

  window.addEventListener('message', async (e) => {
    if (e.origin !== TRUSTED_ORIGIN) return;
    const d = e.data;
    if (!d || d.type !== 'wechat-oauth-callback') return;
    // If the bridge repeats the state, it must be the one this page issued. When
    // it does not carry one, our own copy is used below, so the server still
    // compares against a value only this page knows.
    if (d.state && d.state !== STATE) return;
    try {
      // Relative to this page, not root-absolute: with ORCATERM_CAPTURE_BASE set
      // to a URL with a path, '/cb' would leave the path and never reach this
      // server.
      const r = await fetch(new URL('cb', location.href), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: d.code, state: d.state || STATE, error: d.error }),
      });
      const j = await r.json();
      done(j.ok ? 'Scanned — signing in… (you can close this page once it finishes)'
                : ('Sign-in failed: ' + (j.error || 'unknown error')), !j.ok);
    } catch (err) {
      done('Sign-in failed: ' + err, true);
    }
  });
</script>
</html>`

/**
 * The local page that embeds the QR widget and hands back the code.
 * Returns {ready, wait, close}: `ready` resolves to the page URL, `wait` to
 * {code, state} once the scan comes back.
 */
export function createLocalCapture({ appid, redirectUri, state, timeoutMs = 300000 }) {
  // The origin the bridge page will answer from, taken from the redirect_uri
  // OrcaTerm issued rather than hardcoded.
  let bridgeOrigin = "https://orcaterm.com"
  try {
    bridgeOrigin = new URL(redirectUri).origin
  } catch {
    /* keep the default */
  }

  let settleWait
  let failWait
  let resolveReady
  let rejectReady
  let settled = false

  // `ready` can fail: a bind error other than a busy port has to reach the
  // caller as a failed sign-in rather than leave it awaiting forever.
  const ready = new Promise((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  ready.catch(() => {})
  const wait = new Promise((res, rej) => {
    settleWait = res
    failWait = rej
  })
  wait.catch(() => {})

  const server = http.createServer((req, res) => {
    // One bad request must not take the host process down: this handler runs in
    // magpie's own event loop, where a throw is an uncaught exception.
    req.on("error", () => {})
    res.on("error", () => {})
    try {
      handle(req, res)
    } catch (err) {
      try {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
      } catch {
        /* the response was already gone */
      }
    }
  })

  const handle = (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/login")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(PAGE({ appid, redirectUri, state, bridgeOrigin }))
      return
    }

    if (req.method === "POST" && url.pathname === "/cb") {
      // Only our own page may hand over a code. Any site the user has open could
      // otherwise POST its own code here while the page waits, finishing the
      // sign-in with a credential we did not ask for. The page is served from
      // this origin, so a same-origin POST carries it; anything else — including
      // a request with no Origin at all — is refused.
      if (!originAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: false, error: "origin not allowed" }))
        return
      }
      let raw = ""
      req.on("data", (c) => {
        raw += c
        if (raw.length > 64 * 1024) req.destroy()
      })
      req.on("end", () => {
        let body = {}
        try {
          body = JSON.parse(raw || "{}")
        } catch {
          /* ignore */
        }
        // OrcaTerm's bridge uses null for missing URL parameters: successful
        // scans carry error: null, and cancellations can carry code: null.
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            typeof body.state !== "string" ||
            (body.error != null && typeof body.error !== "string") ||
            (body.code != null && typeof body.code !== "string") ||
            (typeof body.code !== "string" && !body.error)) {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: false, error: "invalid callback body" }))
          return
        }
        // the code must belong to the sign-in this page started
        const stateOk = body.state === state
        const ok = Boolean(body.code) && !body.error && stateOk
        const why = body.error || (!stateOk ? "state mismatch" : "no code")
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: why }))
        if (!ok || settled) return
        settled = true
        clearTimeout(timer)
        settleWait({ code: body.code, state })
      })
      return
    }

    res.writeHead(404).end()
  }

  function close() {
    clearTimeout(timer)
    try {
      server.close()
    } catch {
      /* ignore */
    }
  }

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    close()
    failWait(new Error("Timed out waiting for the scan; try again."))
  }, timeoutMs)

  const wantPort = Number(process.env.ORCATERM_CAPTURE_PORT) || 4080
  const base = process.env.ORCATERM_CAPTURE_BASE || ""
  const host = process.env.ORCATERM_CAPTURE_HOST || "127.0.0.1"

  // The origin the page is actually served from, known once the socket is bound.
  let pageOrigin = ""

  // Origins this server may be reached by, filled in once the socket is bound.
  const boundOrigins = new Set()

  /**
   * Which `Origin`s a POST to /cb may carry.
   *
   * Only addresses this server is actually reachable on — built here from the
   * bind address and, for a wildcard bind, this machine's own interface
   * addresses — plus the proxy's origin when `ORCATERM_CAPTURE_BASE` points at
   * one.
   *
   * `Origin` is deliberately **not** compared with the request's `Host`: both
   * come from the request, so a DNS-rebinding page (`Host: evil.example`,
   * `Origin: http://evil.example`, resolving to 127.0.0.1) satisfies that
   * comparison and could settle the sign-in with a code of its own. The state is
   * in the page's HTML, so it is no secret against anyone who can load the page —
   * which is why the origin is checked against addresses the request cannot
   * invent. A rebinding page still sends its own hostname as the origin, never a
   * bare interface address, so listing those is safe and keeps
   * `ORCATERM_CAPTURE_HOST=0.0.0.0` usable.
   */
  const originAllowed = (req) => {
    const origin = req.headers.origin ?? ""
    if (!origin) return false // a plain form or a non-browser client
    return boundOrigins.has(origin)
  }

  const listen = (port) => {
    const onErr = (e) => {
      // A busy fixed port is fine — any free one will do, the URL tells the user
      // where to go. But when a base URL is configured the page is reached
      // through that proxy, which cannot know a random port, so falling back
      // would hand out a URL that points at whatever else owns 4080.
      if (e?.code === "EADDRINUSE" && port !== 0 && !base) {
        listen(0)
        return
      }
      // Any other bind error must fail the sign-in, not leave `ready` pending:
      // `authorize()` awaits it, so a pending promise is a hung login with no
      // explanation.
      if (!settled) {
        settled = true
        clearTimeout(timer)
        rejectReady(e)
        failWait(e)
      }
    }
    server.once("error", onErr)
    // `listen()` validates the port synchronously and throws on a bad one, before
    // the error handler can fire — so a bad ORCATERM_CAPTURE_PORT would escape
    // `createLocalCapture` and leave the 300 s timer armed.
    try {
      server.listen(port, host, () => {
        server.removeListener("error", onErr)
        const actual = server.address().port
        pageOrigin = `http://${host.includes(":") ? `[${host}]` : host}:${actual}`

        // Everything this socket answers on. `localhost` and `127.0.0.1` are the
        // two spellings a browser may use for the loopback; a wildcard bind also
        // answers on each of this machine's own addresses, so those are accepted
        // too — otherwise `ORCATERM_CAPTURE_HOST=0.0.0.0` would hand out a page
        // whose own POST gets refused.
        boundOrigins.add(`http://127.0.0.1:${actual}`)
        boundOrigins.add(`http://localhost:${actual}`)
        boundOrigins.add(`http://[::1]:${actual}`)
        if (host === "0.0.0.0" || host === "::") {
          boundOrigins.add(pageOrigin)
          for (const list of Object.values(os.networkInterfaces())) {
            for (const nic of list ?? []) {
              const addr = nic?.address
              if (!addr) continue
              if (nic.family === "IPv4") boundOrigins.add(`http://${addr}:${actual}`)
              else if (nic.family === "IPv6") boundOrigins.add(`http://[${addr}]:${actual}`)
            }
          }
        } else {
          boundOrigins.add(pageOrigin)
        }
        if (base) {
          try {
            boundOrigins.add(new URL(base).origin)
          } catch {
            /* a bare host in the env var: nothing to compare */
          }
        }

        // The socket must not keep the process alive on its own, and neither
        // should the timer: `close()` runs when the sign-in finishes or times
        // out, and `unref` means a leaked capture cannot hold the host open.
        server.unref?.()
        timer.unref?.()
        if (base) {
          // behind a proxy the page is served at the base URL; keep it as given
          resolveReady(`${base.replace(/\/+$/, "")}/login`)
        } else {
          const shown = host === "0.0.0.0" ? "127.0.0.1" : host
          resolveReady(`http://${shown}:${actual}/login`)
        }
      })
    } catch (err) {
      server.removeListener("error", onErr)
      if (!settled) {
        settled = true
        clearTimeout(timer)
        rejectReady(err)
        failWait(err)
      }
    }
  }

  listen(wantPort)

  return { ready, wait, close }
}
