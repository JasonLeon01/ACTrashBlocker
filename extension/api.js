import { API, SITE, uid } from './core.js';

export class ApiError extends Error {
  constructor(message, { code = 'API_ERROR', pause = false, uncertain = false } = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, { code, pause, uncertain });
  }
}

async function request(path, { method = 'GET', body, authenticated = true } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method, credentials: authenticated ? 'include' : 'omit', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(15_000),
      ...(body ? { body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}),
    });
  } catch {
    throw new ApiError('网络请求失败或超时，请稍后重试', { code: 'NETWORK', uncertain: method === 'POST' });
  }
  if ([403, 412, 429].includes(response.status)) {
    throw new ApiError('B 站限制了请求，请在网站检查登录或验证状态后再继续', { code: `HTTP_${response.status}`, pause: true });
  }
  if (!response.ok) throw new ApiError(`B 站服务返回 HTTP ${response.status}`, { uncertain: method === 'POST' });
  let json;
  try { json = await response.json(); } catch {
    throw new ApiError('B 站返回了无法识别的数据', { uncertain: method === 'POST' });
  }
  if (json.code !== 0) {
    const code = Number(json.code);
    if (code === -101) throw new ApiError('请先登录 B 站，再刷新登录状态', { code: 'LOGIN_REQUIRED', pause: true });
    if ([-111, -403, -412, -352, -509, -102].includes(code)) {
      throw new ApiError(`B 站暂不允许操作：${String(json.message || '请检查登录或验证状态').slice(0, 150)}（${code}）`, { code: String(code), pause: true });
    }
    throw new ApiError(`B 站返回：${String(json.message || '操作失败').slice(0, 150)}（${json.code}）`, { code: String(json.code) });
  }
  return json.data;
}

export async function getAccount() {
  try {
    const data = await request('/x/web-interface/nav');
    if (!data?.isLogin || !uid(data.mid)) return { loggedIn: false, uid: null, name: '', error: '请先登录 B 站' };
    return { loggedIn: true, uid: uid(data.mid), name: String(data.uname || '').slice(0, 100) };
  } catch (error) {
    if (error.code === 'LOGIN_REQUIRED') return { loggedIn: false, uid: null, name: '', error: error.message };
    throw error;
  }
}

export async function getOwner(video) {
  const query = video.bvid ? `bvid=${encodeURIComponent(video.bvid)}` : `aid=${encodeURIComponent(video.aid)}`;
  const data = await request(`/x/web-interface/view?${query}`, { authenticated: false });
  if (!data || !uid(data.owner?.mid) || (video.bvid && data.bvid !== video.bvid) || (video.aid && uid(data.aid) !== video.aid)) {
    throw new ApiError('目标视频与投稿者信息无法核对，未加入可拉黑名单');
  }
  return { uid: uid(data.owner.mid), name: String(data.owner.name || `UID ${data.owner.mid}`).slice(0, 100),
    title: String(data.title || video.title).slice(0, 240), bvid: data.bvid, aid: uid(data.aid) };
}

export async function isBlocked(targetUid) {
  if (!uid(targetUid)) throw new ApiError('无效的 UP 主 UID');
  const data = await request(`/x/relation?fid=${encodeURIComponent(targetUid)}`);
  if (!data || !Number.isInteger(data.attribute)) throw new ApiError('无法确认当前账号的拉黑关系');
  return (data.attribute & 128) === 128;
}

export async function getWriteToken(actorUid) {
  const [csrf, user] = await Promise.all([
    chrome.cookies.get({ url: SITE, name: 'bili_jct' }),
    chrome.cookies.get({ url: SITE, name: 'DedeUserID' }),
  ]);
  if (!csrf?.value || !user?.value) throw new ApiError('登录信息不完整，请重新登录 B 站', { code: 'LOGIN_REQUIRED', pause: true });
  if (uid(user.value) !== actorUid) throw new ApiError('B 站账号已经切换，已暂停本批操作', { code: 'ACCOUNT_CHANGED', pause: true });
  return csrf.value;
}

export async function blockUser(targetUid, csrf) {
  if (!uid(targetUid) || typeof csrf !== 'string' || !csrf) throw new ApiError('拉黑请求参数不完整');
  await request('/x/relation/modify', { method: 'POST', body: new URLSearchParams({
    fid: targetUid, act: '5', re_src: '11', gaia_source: 'web_main', csrf,
  }) });
}
