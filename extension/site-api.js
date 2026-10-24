/* Run authenticated website operations in the site's isolated content-script context. */
(() => {
  "use strict";

  const SITE = "https://www.bilibili.com";
  const API = "https://api.bilibili.com";
  if (window.top !== window || location.origin !== SITE || globalThis.__ACTrashSiteApiInstalled) return;
  globalThis.__ACTrashSiteApiInstalled = true;

  const writes = new Map();
  const validUid = value => typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value);
  const validRequestId = value => typeof value === "string" && /^[\w:-]{8,128}$/u.test(value);

  class SiteError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  function cookie(name) {
    try {
      const prefix = `${name}=`;
      const entry = document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith(prefix));
      return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
    } catch { return null; }
  }

  function safeUid(value) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
    const normalized = String(value ?? "");
    return validUid(normalized) ? normalized : undefined;
  }

  function sanitizeBody(json, operation, csrf) {
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const code = Number.isInteger(json.code) ? json.code
      : typeof json.code === "string" && /^-?\d{1,9}$/u.test(json.code) ? Number(json.code) : undefined;
    let message = typeof json.message === "string" ? json.message : typeof json.msg === "string" ? json.msg : "";
    if (csrf) message = message.split(csrf).join("[redacted]");
    let data = null;
    if (json.data && typeof json.data === "object") {
      if (operation === "ACCOUNT") {
        data = {
          ...(typeof json.data.isLogin === "boolean" ? { isLogin: json.data.isLogin } : {}),
          ...(safeUid(json.data.mid) ? { mid: safeUid(json.data.mid) } : {}),
          uname: typeof json.data.uname === "string" ? json.data.uname.slice(0, 100) : "",
        };
      } else if (operation === "RELATION") {
        data = Number.isInteger(json.data.attribute) ? { attribute: json.data.attribute } : {};
      }
    }
    return { ...(code !== undefined ? { code } : {}), message: message.slice(0, 240), data };
  }

  async function fetchOperation(operation, targetUid, csrf, onDispatch = () => {}) {
    const url = operation === "ACCOUNT" ? `${API}/x/web-interface/nav`
      : operation === "RELATION" ? `${API}/x/relation?fid=${encodeURIComponent(targetUid)}`
      : `${API}/x/relation/modify`;
    const options = {
      method: operation === "BLOCK" ? "POST" : "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    };
    if (operation === "BLOCK") {
      options.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      options.body = new URLSearchParams({ fid: targetUid, act: "5", re_src: "11", gaia_source: "web_main", csrf });
    }
    let response;
    try {
      onDispatch();
      response = await fetch(url, options);
    } catch {
      throw new SiteError("NETWORK", "页面请求失败或超时，请检查网络后重试");
    }
    let raw;
    try { raw = await response.text(); }
    catch { throw new SiteError("INVALID_RESPONSE", "无法读取 B 站响应，请稍后核对操作结果"); }
    let body = null;
    try { body = sanitizeBody(JSON.parse(raw), operation, csrf); }
    catch {
      if (response.ok) throw new SiteError("INVALID_RESPONSE", "B 站返回了非 JSON 响应，暂无法确认操作结果");
    }
    if (response.ok && (!body || body.code === undefined)) {
      throw new SiteError("INVALID_RESPONSE", "B 站响应缺少有效状态码，暂无法确认操作结果");
    }
    const retryAfter = response.headers.get("retry-after");
    return { status: response.status, body, ...(retryAfter ? { retryAfter: retryAfter.slice(0, 100) } : {}) };
  }

  async function verifyActor(actorUid) {
    const visibleUid = cookie("DedeUserID");
    if (validUid(visibleUid)) {
      if (visibleUid !== actorUid) throw new SiteError("ACCOUNT_CHANGED", "B 站账号已经切换，已暂停本批操作");
      return;
    }
    // A cookie that JavaScript cannot read is not evidence that the user signed out.
    let response;
    try { response = await fetchOperation("ACCOUNT"); }
    catch (error) { throw new SiteError("AUTH_UNAVAILABLE", `页面账号核对失败：${error.message}`); }
    if (response.status < 200 || response.status >= 300) {
      throw new SiteError("AUTH_UNAVAILABLE", `页面账号核对失败（HTTP ${response.status}），暂无法确认当前登录状态`);
    }
    const body = response.body;
    if (body?.code === -101 || (body?.code === 0 && body.data?.isLogin === false)) {
      throw new SiteError("LOGIN_REQUIRED", "页面确认 B 站未登录或登录已过期，请登录后继续");
    }
    if (body?.code !== 0 || body.data?.isLogin !== true || !validUid(body.data.mid)) {
      const detail = body?.code !== undefined ? `（站点代码 ${body.code}）` : "";
      throw new SiteError("AUTH_UNAVAILABLE", `页面账号核对失败${detail}，暂无法确认当前登录状态`);
    }
    if (body.data.mid !== actorUid) throw new SiteError("ACCOUNT_CHANGED", "B 站账号已经切换，已暂停本批操作");
  }

  async function execute(request) {
    let dispatched = false;
    try {
      if (request.operation !== "ACCOUNT") await verifyActor(request.actorUid);
      let csrf;
      if (request.operation === "BLOCK") {
        csrf = cookie("bili_jct");
        if (!csrf) throw new SiteError("CSRF_UNAVAILABLE", "页面无法读取操作校验信息，请刷新 B 站页面后重试");
      }
      // Recheck a readable identity immediately before the requested operation.
      const visibleUid = cookie("DedeUserID");
      if (request.operation !== "ACCOUNT" && validUid(visibleUid) && visibleUid !== request.actorUid) {
        throw new SiteError("ACCOUNT_CHANGED", "B 站账号已经切换，已暂停本批操作");
      }
      const response = await fetchOperation(request.operation, request.targetUid, csrf, () => { dispatched = true; });
      return { requestId: request.requestId, ok: true, response };
    } catch (error) {
      return { requestId: request.requestId, ok: false, error: {
        code: error.code || "SITE_REQUEST_FAILED", message: error.message || "页面请求未完成",
        pause: true, uncertain: request.operation === "BLOCK" && dispatched,
      } };
    }
  }

  function pruneWrites() {
    let completed = [...writes.values()].filter(record => record.settled).length;
    for (const [id, record] of writes) {
      if (completed <= 100) break;
      if (record.settled) { writes.delete(id); completed -= 1; }
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!["SITE_API", "SITE_API_PING"].includes(message?.type) || sender.id !== chrome.runtime.id || sender.tab ||
        window.top !== window || location.origin !== SITE) return false;
    if (message.type === "SITE_API_PING") {
      if (validRequestId(message.requestId)) respond({ requestId: message.requestId, ok: true });
      return false;
    }
    const request = { requestId: message.requestId, operation: message.operation,
      targetUid: message.targetUid, actorUid: message.actorUid };
    if (!validRequestId(request.requestId) || !["ACCOUNT", "RELATION", "BLOCK"].includes(request.operation) ||
        (request.operation !== "ACCOUNT" && (!validUid(request.targetUid) || !validUid(request.actorUid)))) {
      respond({ requestId: request.requestId, ok: false, error: {
        code: "INVALID_REQUEST", message: "页面请求参数无效", pause: true, uncertain: false,
      } });
      return false;
    }
    let promise;
    if (request.operation === "BLOCK") {
      const signature = `${request.actorUid}:${request.targetUid}`;
      const previous = writes.get(request.requestId);
      if (previous && previous.signature !== signature) {
        respond({ requestId: request.requestId, ok: false, error: {
          code: "INVALID_REQUEST", message: "重复请求的目标不一致，未执行操作", pause: true, uncertain: false,
        } });
        return false;
      }
      if (previous) promise = previous.promise;
      else {
        const record = { signature, settled: false, promise: execute(request) };
        writes.set(request.requestId, record);
        promise = record.promise;
        void promise.then(() => { record.settled = true; pruneWrites(); });
      }
    } else promise = execute(request);
    void promise.then(result => {
      try { respond(result); } catch { /* The page or extension may have closed after dispatch. */ }
    });
    return true;
  });
})();
