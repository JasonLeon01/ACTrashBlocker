const SITE = 'https://www.bilibili.com';
const OPERATIONS = new Set(['ACCOUNT', 'RELATION', 'BLOCK']);

export class SiteTransportError extends Error {
  constructor(message, { code = 'SITE_UNAVAILABLE', uncertain = false } = {}) {
    super(message);
    this.name = 'SiteTransportError';
    Object.assign(this, { code, pause: true, uncertain });
  }
}

function validUid(value) { return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value); }

function isWebsiteTab(tab, incognito) {
  try {
    return Number.isInteger(tab?.id) && !tab.discarded && Boolean(tab.incognito) === incognito && new URL(tab.url).origin === SITE;
  } catch { return false; }
}

async function timedMessage(tabId, message, timeout) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Page message timed out')), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function findWebsiteTab(preferredId) {
  const incognito = Boolean(chrome.extension?.inIncognitoContext);
  let preferred = null;
  if (preferredId !== undefined && preferredId !== null) {
    if (!Number.isInteger(preferredId)) throw new SiteTransportError('标签页标识无效', { code: 'INVALID_REQUEST' });
    try { preferred = await chrome.tabs.get(preferredId); } catch { /* A closed source tab can use another connected site tab. */ }
    if (preferred && Boolean(preferred.incognito) !== incognito) {
      throw new SiteTransportError('不能在普通窗口和无痕窗口之间切换账号执行操作，请在原浏览器会话中继续', { code: 'CONTEXT_MISMATCH' });
    }
  }
  let tabs;
  try { tabs = await chrome.tabs.query({ url: `${SITE}/*` }); }
  catch { throw new SiteTransportError('无法查找已连接的 B 站页面，请打开或刷新 B 站网页后重试'); }
  if (preferred && !tabs.some(tab => tab.id === preferred.id)) tabs.unshift(preferred);
  tabs = tabs.filter(tab => isWebsiteTab(tab, incognito));
  tabs.sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId) || Number(Boolean(b.active)) - Number(Boolean(a.active)));
  if (!tabs.length) throw new SiteTransportError('请保持至少一个 B 站网页打开，再继续任务', { code: 'SITE_TAB_REQUIRED' });
  for (const tab of tabs) {
    const requestId = crypto.randomUUID();
    try {
      const reply = await timedMessage(tab.id, { type: 'SITE_API_PING', requestId }, 2_000);
      if (reply?.ok === true && reply.requestId === requestId) return tab.id;
    } catch { /* Probe another page only before any requested site operation is dispatched. */ }
  }
  throw new SiteTransportError('B 站页面尚未连接插件，请刷新已打开的 B 站网页后重试', { code: 'SITE_HANDLER_REQUIRED' });
}

export async function callSite(operation, { tabId, targetUid, actorUid } = {}) {
  if (!OPERATIONS.has(operation) || (operation !== 'ACCOUNT' && (!validUid(targetUid) || !validUid(actorUid)))) {
    throw new SiteTransportError('站点请求参数无效', { code: 'INVALID_REQUEST' });
  }
  const selectedTab = await findWebsiteTab(tabId);
  const requestId = crypto.randomUUID();
  let reply;
  try {
    reply = await timedMessage(selectedTab, { type: 'SITE_API', requestId, operation, targetUid, actorUid }, 35_000);
  } catch {
    throw new SiteTransportError(operation === 'BLOCK'
      ? '页面连接中断，拉黑请求可能已提交；请保持 B 站页面打开后核对结果，不会自动重复提交'
      : '页面连接中断，请刷新 B 站网页后重试', { code: 'SITE_CONNECTION_LOST', uncertain: operation === 'BLOCK' });
  }
  const invalidReply = () => new SiteTransportError('页面返回的数据不完整，暂无法确认操作结果', {
    code: 'SITE_INVALID_RESPONSE', uncertain: operation === 'BLOCK',
  });
  if (!reply || reply.requestId !== requestId || typeof reply.ok !== 'boolean') throw invalidReply();
  if (!reply.ok) {
    const error = reply.error;
    if (!error || typeof error.code !== 'string' || typeof error.message !== 'string' || typeof error.uncertain !== 'boolean') throw invalidReply();
    throw new SiteTransportError(error.message.slice(0, 400), {
      code: error.code.slice(0, 80), uncertain: operation === 'BLOCK' && error.uncertain,
    });
  }
  const response = reply.response;
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 ||
      (response.body !== null && (typeof response.body !== 'object' || Array.isArray(response.body)))) throw invalidReply();
  return response;
}
