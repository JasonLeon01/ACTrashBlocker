import { API, uid } from './core.js';
import { callSite } from './site-transport.js';

export class ApiError extends Error {
  constructor(message, { code = 'API_ERROR', pause = false, uncertain = false, stage, status, siteCode } = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, { code, pause, uncertain, stage, status, siteCode });
  }
}

function failure(stage, message, options = {}) {
  return new ApiError(`${stage}失败：${message}`, { ...options, stage });
}

function parseResponse(response, stage, write = false) {
  const { status, body, retryAfter } = response;
  if (status === 403 || status === 412) {
    throw failure(stage, `B 站拒绝了请求（HTTP ${status}），这不等于未登录。请在网站检查是否有验证提示，稍后再试`, {
      code: `HTTP_${status}`, status, pause: true,
    });
  }
  if (status === 429) {
    const seconds = typeof retryAfter === 'string' && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) : 0;
    throw failure(stage, `请求过于频繁（HTTP 429），请${seconds > 0 ? `至少等待 ${seconds} 秒后` : '稍后'}再试`, {
      code: 'HTTP_429', status, pause: true,
    });
  }
  if (status < 200 || status >= 300) {
    throw failure(stage, `B 站服务返回 HTTP ${status}，暂无法完成此操作`, {
      code: `HTTP_${status}`, status, pause: status === 401 || status >= 500, uncertain: write && status >= 500,
    });
  }
  const code = typeof body?.code === 'number' && Number.isInteger(body.code) ? body.code
    : typeof body?.code === 'string' && /^-?\d{1,9}$/.test(body.code) ? Number(body.code) : null;
  if (code === null) throw failure(stage, 'B 站响应缺少有效状态码，暂无法确认操作结果', {
    code: 'INVALID_RESPONSE', status, pause: true, uncertain: write,
  });
  if (code === -101) throw failure(stage, '站点确认当前会话未登录或已过期，请登录后继续', {
    code: 'LOGIN_REQUIRED', status, siteCode: code, pause: true,
  });
  if (code === -111) throw failure(stage, '操作校验信息已失效（站点代码 -111），请刷新 B 站页面后重试', {
    code: 'CSRF_INVALID', status, siteCode: code, pause: true,
  });
  if (code !== 0) {
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.slice(0, 180) : '操作未完成';
    throw failure(stage, `B 站返回：${message}（站点代码 ${code}）`, {
      code: String(code), status, siteCode: code, pause: [-403, -412, -352, -509, -102].includes(code),
    });
  }
  return body.data;
}

async function siteRequest(operation, stage, options) {
  let response;
  try { response = await callSite(operation, options); }
  catch (error) {
    throw failure(stage, error.message || '无法连接 B 站页面', {
      code: error.code || 'SITE_UNAVAILABLE', pause: true, uncertain: Boolean(error.uncertain),
    });
  }
  return parseResponse(response, stage, operation === 'BLOCK');
}

export async function getAccount({ tabId } = {}) {
  const stage = '检查登录';
  try {
    const data = await siteRequest('ACCOUNT', stage, { tabId });
    if (data?.isLogin === false) return { verified: true, loggedIn: false, uid: null, name: '', error: '站点确认当前会话未登录' };
    if (data?.isLogin !== true || !uid(data.mid)) throw failure(stage, 'B 站未返回可核验的账号身份，当前登录状态未知', {
      code: 'AUTH_UNAVAILABLE', pause: true,
    });
    return { verified: true, loggedIn: true, uid: uid(data.mid), name: String(data.uname || '').slice(0, 100) };
  } catch (error) {
    if (error.code === 'LOGIN_REQUIRED') return { verified: true, loggedIn: false, uid: null, name: '', error: error.message };
    throw error;
  }
}

export async function getOwner(video) {
  const stage = '查询视频作者';
  const query = video.bvid ? `bvid=${encodeURIComponent(video.bvid)}` : `aid=${encodeURIComponent(video.aid)}`;
  let response;
  try {
    response = await fetch(`${API}/x/web-interface/view?${query}`, {
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch { throw failure(stage, '网络请求失败或超时，请稍后重试', { code: 'NETWORK' }); }
  let body = null;
  try { body = await response.json(); }
  catch {
    if (response.ok) throw failure(stage, 'B 站返回了无法识别的数据', { code: 'INVALID_RESPONSE' });
  }
  const data = parseResponse({ status: response.status, body, retryAfter: response.headers.get('retry-after') }, stage);
  if (!data || !uid(data.owner?.mid) || (video.bvid && data.bvid !== video.bvid) || (video.aid && uid(data.aid) !== video.aid)) {
    throw failure(stage, '目标视频与投稿者信息无法核对，未加入可拉黑名单');
  }
  return { uid: uid(data.owner.mid), name: String(data.owner.name || `UID ${data.owner.mid}`).slice(0, 100),
    title: String(data.title || video.title).slice(0, 240), bvid: data.bvid, aid: uid(data.aid) };
}

export async function isBlocked(targetUid, actorUid, { tabId, stage = '查询拉黑关系' } = {}) {
  if (!uid(targetUid) || !uid(actorUid)) throw failure(stage, '无效的账号或 UP 主 UID', { code: 'INVALID_REQUEST' });
  const data = await siteRequest('RELATION', stage, { tabId, targetUid: uid(targetUid), actorUid: uid(actorUid) });
  if (!data || !Number.isInteger(data.attribute)) throw failure(stage, '无法确认当前账号的拉黑关系', { code: 'INVALID_RESPONSE', pause: true });
  return (data.attribute & 128) === 128;
}

export async function blockUser(targetUid, actorUid, { tabId } = {}) {
  const stage = '提交拉黑';
  if (!uid(targetUid) || !uid(actorUid)) throw failure(stage, '无效的账号或 UP 主 UID', { code: 'INVALID_REQUEST' });
  await siteRequest('BLOCK', stage, { tabId, targetUid: uid(targetUid), actorUid: uid(actorUid) });
}
