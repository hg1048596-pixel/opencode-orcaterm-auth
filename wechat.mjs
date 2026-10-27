/**
 * 微信扫码登录 OrcaTerm。
 *
 * 走的是 OrcaTerm 自己的 OAuth，而不是控制台会话 cookie：
 *
 *   GET  {OAUTH}/oauth/wechat/config   → {appid, redirect_uri, state, scope}
 *   →  在本地页面里内嵌微信 qrconnect（self_redirect: true）
 *   扫码后微信回跳 {redirect_uri}（/oauth/wechat/bridge?code&state），
 *   那个页面会把结果 postMessage 给宿主页 —— 就是我们的页面
 *   POST {OAUTH}/oauth/wechat/exchange  → {userId, accessToken, expiresIn, …}
 *   POST {CAPI}?action=OAuthRefreshToken → 续期
 *
 * 为什么必须 self_redirect：qrconnect 页面扫码后默认做**顶层跳转**，会把宿主页
 * 整个换掉，postMessage 就收不到了。设成 true 后回跳发生在它自己创建的内层
 * iframe 里，bridge 页的 window.parent 仍是我们的页面。
 *
 * 换来的 accessToken 是 1024 字符的 JWT，2 小时有效、可续期，权限面比
 * uin+skey（等同腾讯云控制台完整会话）小得多 —— 实测它能直接驱动
 * /assistant/chat，包括 TokenHub/ 与 Hunyuan3/ 那些带前缀的模型。
 */
import http from "node:http"

export const OAUTH_BASE = "https://orcaterm.com"
export const CAPI_URL = "https://api.orcaterm.cloud.tencent.com/cgi/api"

const WECHAT_QRCONNECT = "https://open.weixin.qq.com/connect/qrconnect"

export class WechatLoginError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = "WechatLoginError"
    this.code = code
  }
}

const FRIENDLY = {
  STATE_EXPIRED: "二维码已过期（微信 code 只有约 5 分钟且只能用一次），请重新扫码",
  STATE_MISMATCH: "state 已失效，请重新发起扫码",
  INVALID_REQUEST: "微信返回的 code 无效（可能已被用过），请重新扫码",
  PROVIDER_DISABLED: "OrcaTerm 侧已关闭微信登录",
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
      /* 非 JSON */
    }
    return { res, body, text }
  } finally {
    clearTimeout(t)
  }
}

/** 第一步：拿 appid/redirect_uri/state，拼出扫码地址。 */
export async function startWechatLogin({ base = OAUTH_BASE } = {}) {
  const { res, body, text } = await jsonFetch(`${base}/oauth/wechat/config`, {
    headers: { accept: "application/json" },
  })
  const d = body?.data
  if (!res.ok || Number(body?.code) !== 0 || !d) {
    throw new WechatLoginError(String(body?.code ?? "INTERNAL_ERROR"), body?.message || text.slice(0, 120) || `[config] http ${res.status}`)
  }
  if (!d.appid || !d.redirect_uri || !d.state || !d.scope) {
    throw new WechatLoginError("INTERNAL_ERROR", "[config] 响应缺字段")
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

/** 第四步：用 code 换 token。 */
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
    throw new WechatLoginError(code2, FRIENDLY[code2] || body?.message || text.slice(0, 160) || "微信登录失败")
  }
  const d = body.data
  if (!d.accessToken) throw new WechatLoginError("INTERNAL_ERROR", "[exchange] 响应没有 accessToken")
  const expiresIn = Number(d.expiresIn) || 0
  return {
    userId: String(d.userId ?? ""),
    nickname: d.providerUsername ?? "",
    avatar: d.avatar ?? "",
    accessToken: d.accessToken,
    expiresIn,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
  }
}

/** 续期：拿当前 token 换一个新的，有效期同样 2 小时。 */
export async function refreshAccessToken(token, { base = OAUTH_BASE } = {}) {
  const { res, body, text } = await jsonFetch(
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
  if (!next) throw new WechatLoginError("INTERNAL_ERROR", `续期失败：${(r?.Error?.Message || text).slice(0, 120)}`)
  const expiresIn = Number(r?.expiresIn ?? r?.ExpiresIn) || 0
  return { accessToken: next, expiresIn, expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null }
}

/** JWT 里读出 userId / 过期时间，用于展示与本地判过期（不校验签名）。 */
export function readTokenClaims(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"))
    return { userId: p?.userId != null ? String(p.userId) : "", nickname: p?.providerUsername ?? "", exp: Number(p?.exp) || 0 }
  } catch {
    return { userId: "", nickname: "", exp: 0 }
  }
}

/** 看着像微信 OAuth 的 accessToken（JWT）。 */
export function looksLikeAccessToken(s) {
  return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(String(s ?? "").trim())
}

const PAGE = ({ appid, redirectUri, state }) => `<!doctype html>
<html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OrcaTerm 微信登录</title>
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

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || d.type !== 'wechat-oauth-callback') return;
    try {
      const r = await fetch('/cb', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: d.code, state: d.state, error: d.error }),
      });
      const j = await r.json();
      done(j.ok ? '扫码已收到，正在登录…（成功后这个页面可以关掉）'
                : ('登录失败：' + (j.error || '未知错误')), !j.ok);
    } catch (err) {
      done('登录失败：' + err, true);
    }
  });
</script>
</html>`

/**
 * 本地接收页：内嵌二维码，扫完把 code 收回。
 * 返回 {ready, wait, close}；ready 是页面地址，wait 等到 {code, state}。
 */
export function createLocalCapture({ appid, redirectUri, state, timeoutMs = 300000 }) {
  let settleWait
  let failWait
  let resolveReady
  let settled = false

  const ready = new Promise((r) => {
    resolveReady = r
  })
  const wait = new Promise((res, rej) => {
    settleWait = res
    failWait = rej
  })
  wait.catch(() => {})

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/login")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(PAGE({ appid, redirectUri, state }))
      return
    }

    if (req.method === "POST" && url.pathname === "/cb") {
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
          /* 忽略 */
        }
        const ok = Boolean(body.code) && !body.error
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: body.error || "没有 code" }))
        if (!ok || settled) return
        settled = true
        clearTimeout(timer)
        settleWait({ code: body.code, state: body.state || state })
      })
      return
    }

    res.writeHead(404).end()
  })

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
    failWait(new Error("等待扫码超时，请重试"))
  }, timeoutMs)

  const wantPort = Number(process.env.ORCATERM_CAPTURE_PORT) || 4080
  const base = process.env.ORCATERM_CAPTURE_BASE || ""
  const host = process.env.ORCATERM_CAPTURE_HOST || "127.0.0.1"

  const listen = (port) => {
    const onErr = (e) => {
      if (e?.code === "EADDRINUSE" && port !== 0) {
        listen(0)
        return
      }
      if (!settled) {
        settled = true
        clearTimeout(timer)
        failWait(e)
      }
    }
    server.once("error", onErr)
    server.listen(port, host, () => {
      server.removeListener("error", onErr)
      const actual = server.address().port
      const shown = host === "0.0.0.0" ? "127.0.0.1" : host
      resolveReady(`${base || `http://${shown}:${actual}`}/login`)
    })
  }

  listen(wantPort)

  return { ready, wait, close }
}
