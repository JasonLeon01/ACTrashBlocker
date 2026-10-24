import { SITE, STORAGE_KEY, POPUP_COOLDOWN, routeOf, normalizeVideo, videoKey, evidenceList,
  mergeEvidence, mergeVideos, emptyState, candidateView, queueSummary, taskActive } from './core.js';
import { ApiError, getAccount, getOwner, isBlocked, getWriteToken, blockUser } from './api.js';

const WATCHDOG = 'promo-blocker-work';
let state = emptyState();
let serial = Promise.resolve();
let accountRequest = null;
let queueRunning = false;
let resolutionRunning = false;
const popupTimers = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const ready = chrome.storage.session.get(STORAGE_KEY).then(stored => {
  if (stored[STORAGE_KEY]?.version === 1) state = { ...emptyState(), ...stored[STORAGE_KEY] };
});

function update(fn) {
  const work = serial.then(async () => {
    await ready;
    const result = fn(state);
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
    return result;
  });
  serial = work.catch(() => {});
  return work;
}

async function snapshot() {
  await ready;
  await serial;
  return structuredClone(state);
}

function currentPage(s, tabId, pageId) {
  const page = s.pages[tabId];
  return page?.id === pageId ? page : null;
}

function isPopup(sender) {
  return !sender.tab && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
}

async function contentContext(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !sender.documentId ||
      (sender.documentLifecycle && sender.documentLifecycle !== 'active')) throw new Error('无效的页面消息来源');
  if (typeof message.pageId !== 'string' || !/^[\w:-]{8,150}$/.test(message.pageId)) throw new Error('无效的页面标识');
  const url = new URL(message.url);
  const senderUrl = new URL(sender.url);
  if (url.origin !== SITE || senderUrl.origin !== SITE) throw new Error('不支持此站点');
  const tab = await chrome.tabs.get(sender.tab.id);
  if (new URL(tab.url).origin !== SITE || routeOf(tab.url) !== routeOf(url.href)) throw new Error('页面已切换');
  return { tabId: sender.tab.id, documentId: sender.documentId, url: url.href, route: routeOf(url.href) };
}

async function refreshAccount() {
  if (accountRequest) return accountRequest;
  accountRequest = (async () => {
    const epoch = (await snapshot()).authEpoch;
    let account;
    try { account = await getAccount(); }
    catch (error) {
      account = { loggedIn: false, uid: null, name: '', error: `无法确认登录状态：${error.message}` };
    }
    await update(s => {
      if (s.authEpoch !== epoch) account = { loggedIn: false, uid: null, name: '', error: '登录状态刚刚变化，请刷新后重试' };
      s.account = account;
      if (s.queue?.tasks.some(taskActive) && (!account.loggedIn || account.uid !== s.queue.actorUid)) {
        s.queue.paused = true;
        s.queue.reason = account.loggedIn ? '当前 B 站账号与提交任务时不同，请切回原账号或取消剩余任务' : account.error || '请先登录 B 站';
      }
    });
    await refreshBadges();
    return account;
  })().finally(() => { accountRequest = null; });
  return accountRequest;
}

async function refreshBadge(tabId) {
  const s = await snapshot();
  const page = s.pages[tabId];
  const candidates = page?.candidates.map(c => candidateView(c, s)) || [];
  const count = candidates.filter(c => c.uid && !['blocked'].includes(c.status)).length;
  const unknown = candidates.filter(c => !c.uid).length;
  try {
    await chrome.action.setBadgeText({ tabId: Number(tabId), text: count ? (count > 99 ? '99+' : String(count)) : unknown ? '?' : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId: Number(tabId), color: '#D84372' });
    await chrome.action.setTitle({ tabId: Number(tabId), title: count ? `发现 ${count} 位推广 UP 主，点击处理` : unknown ? '发现推广，部分 UP 主尚未确认' : 'B 站推广 UP 主助手' });
  } catch { /* Tab may close while an API request is completing. */ }
}

async function refreshBadges() {
  const s = await snapshot();
  await Promise.all(Object.keys(s.pages).map(refreshBadge));
}

async function configureWatchdog() {
  const s = await snapshot();
  const pending = Object.values(s.pages).some(page => Object.values(page.detections).some(d => d.status === 'pending'));
  if (pending || (s.queue && !s.queue.paused && s.queue.tasks.some(taskActive))) {
    await chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  } else await chrome.alarms.clear(WATCHDOG);
}

function schedulePopup(tabId) {
  if (popupTimers.has(tabId)) clearTimeout(popupTimers.get(tabId));
  void snapshot().then(s => {
    const page = s.pages[tabId];
    if (!page?.popupPending) return;
    const at = Math.max(page.popupDueAt, s.lastPopupAt + POPUP_COOLDOWN);
    popupTimers.set(tabId, setTimeout(() => {
      popupTimers.delete(tabId);
      void tryPopup(tabId).catch(() => {});
    }, Math.max(0, at - Date.now())));
  });
}

async function tryPopup(tabId) {
  const before = await snapshot();
  const page = before.pages[tabId];
  if (!page?.popupPending) return;
  let tab;
  try {
    tab = await chrome.tabs.get(Number(tabId));
    const window = await chrome.windows.get(tab.windowId);
    if (!window.focused || !tab.active || routeOf(tab.url) !== page.route) return;
  } catch { return; }
  const due = Math.max(page.popupDueAt, before.lastPopupAt + POPUP_COOLDOWN);
  if (Date.now() < due) { schedulePopup(tabId); return; }
  const consumed = await update(s => {
    const live = currentPage(s, tabId, page.id);
    if (!live?.popupPending) return false;
    if (Date.now() < s.lastPopupAt + POPUP_COOLDOWN) return 'later';
    live.popupPending = false;
    live.lastPopupAt = Date.now();
    s.lastPopupAt = live.lastPopupAt;
    live.announcedUids = [...new Set([...live.announcedUids, ...live.candidates.filter(c => c.uid).map(c => c.uid)])];
    return true;
  });
  if (consumed === 'later') { schedulePopup(tabId); return; }
  if (consumed) {
    try { await chrome.action.openPopup({ windowId: tab.windowId }); }
    catch { /* The badge remains a manual entry point; never repeatedly steal focus. */ }
  }
}

async function hello(message, sender) {
  const context = await contentContext(message, sender);
  await update(s => {
    if (!context.route) { delete s.pages[context.tabId]; return; }
    const old = s.pages[context.tabId];
    if (old?.id === message.pageId && old.documentId === context.documentId) return;
    s.pages[context.tabId] = { id: message.pageId, url: context.url, route: context.route,
      documentId: context.documentId, candidates: [], detections: {}, announcedUids: [],
      lastPopupAt: old?.lastPopupAt || 0, popupPending: false, popupDueAt: 0 };
  });
  await refreshBadge(context.tabId);
  return { ok: true };
}

async function detected(message, sender) {
  const context = await contentContext(message, sender);
  if (!context.route || !Array.isArray(message.items) || message.items.length > 100) throw new Error('无效的推广候选列表');
  await update(s => {
    const page = currentPage(s, context.tabId, message.pageId);
    if (!page || page.documentId !== context.documentId) throw new ApiError('页面已更新，请重新同步', { code: 'PAGE_STALE' });
    for (const item of message.items) {
      if (!item || typeof item.key !== 'string' || item.key.length > 200) continue;
      const evidence = evidenceList(item.evidence);
      if (!evidence.length) continue;
      const video = normalizeVideo(item.video);
      const key = video ? videoKey(video) : item.key;
      if (video && typeof item.replacesKey === 'string') {
        const replaced = page.detections[item.replacesKey];
        if (replaced && !replaced.video) {
          delete page.detections[item.replacesKey];
          page.candidates = page.candidates.filter(c => c.id !== `unresolved:${item.replacesKey}`);
        }
      }
      const existing = page.detections[key];
      if (existing) {
        existing.evidence = mergeEvidence(existing.evidence, evidence);
        const candidate = page.candidates.find(c => c.id === existing.candidateId);
        if (candidate) candidate.evidence = mergeEvidence(candidate.evidence, evidence);
        continue;
      }
      const id = `unresolved:${key}`;
      page.detections[key] = { key, video, evidence, status: video ? 'pending' : 'failed', candidateId: id };
      page.candidates.push({ id, uid: null, name: video ? '正在确认 UP 主' : '无法识别 UP 主',
        evidence, videos: video ? [video] : [], status: 'unresolved',
        error: video ? '正在查询目标视频的投稿者…' : String(item.reason || '推广未提供可核验的 B 站视频地址').slice(0, 200) });
    }
  });
  await refreshBadge(context.tabId);
  await configureWatchdog();
  kick();
  return { ok: true };
}

async function resolveOne(tabId, pageId, detection) {
  let owner;
  try {
    const s = await snapshot();
    owner = s.videoCache[detection.key] || await getOwner(detection.video);
    await update(live => {
      const page = currentPage(live, tabId, pageId);
      const entry = page?.detections[detection.key];
      if (!entry || entry.status !== 'pending') return;
      live.videoCache[detection.key] = owner;
      const cacheKeys = Object.keys(live.videoCache);
      for (const key of cacheKeys.slice(0, Math.max(0, cacheKeys.length - 300))) delete live.videoCache[key];
      page.candidates = page.candidates.filter(c => c.id !== entry.candidateId || c.uid);
      const video = { ...entry.video, title: owner.title };
      const existing = page.candidates.find(c => c.uid === owner.uid);
      if (existing) {
        existing.videos = mergeVideos(existing.videos, [video]);
        existing.evidence = mergeEvidence(existing.evidence, entry.evidence);
        entry.candidateId = existing.id;
      } else {
        entry.candidateId = `uid:${owner.uid}`;
        page.candidates.push({ id: entry.candidateId, uid: owner.uid, name: owner.name,
          evidence: entry.evidence, videos: [video], status: 'pending', error: '', blockedFor: null });
        if (!page.announcedUids.includes(owner.uid)) {
          if (!page.popupPending) page.popupDueAt = Date.now() + 800;
          page.popupPending = true;
        }
      }
      entry.status = 'done';
    });
  } catch (error) {
    await update(s => {
      const page = currentPage(s, tabId, pageId);
      const entry = page?.detections[detection.key];
      if (!entry) return;
      entry.status = 'failed';
      const candidate = page.candidates.find(c => c.id === entry.candidateId);
      if (candidate) { candidate.name = '无法识别 UP 主'; candidate.error = error.message; }
    });
  }
  await refreshBadge(tabId);
  schedulePopup(tabId);
}

async function resolvePending() {
  if (resolutionRunning) return;
  resolutionRunning = true;
  try {
    while (true) {
      const s = await snapshot();
      const pending = Object.entries(s.pages).flatMap(([tabId, page]) =>
        Object.values(page.detections).filter(d => d.status === 'pending').map(d => [tabId, page.id, d])).slice(0, 2);
      if (!pending.length) break;
      await Promise.all(pending.map(args => resolveOne(...args)));
    }
  } finally {
    resolutionRunning = false;
    await configureWatchdog();
  }
}

class QueueStopped extends Error {}

async function confirmedRelation(targetUid, actorUid) {
  const before = await snapshot();
  const user = await chrome.cookies.get({ url: SITE, name: 'DedeUserID' });
  if (!before.account?.loggedIn || before.account.uid !== actorUid || user?.value !== actorUid) {
    throw new ApiError('登录账号已变化，暂无法确认本批次的拉黑关系', { code: 'ACCOUNT_CHANGED', pause: true, uncertain: true });
  }
  const blocked = await isBlocked(targetUid);
  const after = await snapshot();
  if (after.authEpoch !== before.authEpoch || after.account?.uid !== actorUid || !after.account?.loggedIn) {
    throw new ApiError('查询期间登录状态发生变化，请切回原账号后继续', { code: 'ACCOUNT_CHANGED', pause: true, uncertain: true });
  }
  return { blocked, epoch: before.authEpoch };
}

async function assertTask(queueId, taskId, verificationOnly = false) {
  const s = await snapshot();
  const q = s.queue;
  const task = q?.tasks.find(t => t.id === taskId);
  if (q?.id !== queueId || q.paused || (q.cancelRequested && !verificationOnly) || !task || !taskActive(task)) throw new QueueStopped();
  return { queue: q, task };
}

async function finishTask(queueId, taskId, status, error = '', proofEpoch = null) {
  await update(s => {
    if (s.queue?.id !== queueId) return;
    const task = s.queue.tasks.find(t => t.id === taskId);
    if (!task) return;
    if (status === 'blocked' && (s.authEpoch !== proofEpoch || s.account?.uid !== s.queue.actorUid || !s.account?.loggedIn)) {
      throw new ApiError('确认关系后登录状态发生变化，已暂停任务', { code: 'ACCOUNT_CHANGED', pause: true, uncertain: true });
    }
    task.status = status;
    task.error = error;
    for (const page of Object.values(s.pages)) {
      for (const candidate of page.candidates) {
        if (candidate.uid !== task.uid) continue;
        candidate.lastResult = { actorUid: s.queue.actorUid, status, error };
        if (status === 'blocked') candidate.blockedFor = s.queue.actorUid;
      }
    }
  });
  await refreshBadges();
}

function recordUncertainCancellation(s, task) {
  task.status = 'failed';
  task.error = '此前请求已提交但结果未确认；已停止后续处理，请在原账号黑名单中核对';
  for (const page of Object.values(s.pages)) {
    const candidate = page.candidates.find(c => c.uid === task.uid);
    if (candidate) candidate.lastResult = { actorUid: s.queue.actorUid, status: 'failed', error: task.error };
  }
}

async function runTask(queue, initialTask) {
  const queueId = queue.id;
  const taskId = initialTask.id;
  const wasSubmitted = initialTask.attempted;
  await update(s => {
    const task = s.queue?.id === queueId && s.queue.tasks.find(t => t.id === taskId);
    if (task && taskActive(task)) task.status = 'processing';
  });
  let submitted = wasSubmitted;
  let writeSucceeded = false;
  try {
    await assertTask(queueId, taskId, wasSubmitted);
    const account = await refreshAccount();
    if (!account.loggedIn || account.uid !== queue.actorUid) throw new ApiError('登录状态或账号已变化，请检查后继续', { pause: true });
    await assertTask(queueId, taskId, wasSubmitted);
    if (initialTask.uid === account.uid) throw new ApiError('不能拉黑当前登录账号');
    const existingRelation = await confirmedRelation(initialTask.uid, queue.actorUid);
    if (existingRelation.blocked) {
      await assertTask(queueId, taskId, wasSubmitted);
      await finishTask(queueId, taskId, 'blocked', '', existingRelation.epoch);
      return;
    }
    if (wasSubmitted) {
      await finishTask(queueId, taskId, 'failed', '上次提交的结果未能确认，未重复提交；可手动重试');
      return;
    }
    const tokenEpoch = (await snapshot()).authEpoch;
    const csrf = await getWriteToken(queue.actorUid);
    const current = await snapshot();
    await sleep(Math.max(0, 1000 - (Date.now() - current.lastPostAt)));
    await assertTask(queueId, taskId);
    // Persist intent BEFORE POST. After a worker restart, only verify this task; never blindly replay it.
    await update(s => {
      const q = s.queue;
      const task = q?.tasks.find(t => t.id === taskId);
      if (q?.id !== queueId || q.paused || q.cancelRequested || !task || !taskActive(task) ||
          !s.account?.loggedIn || s.account.uid !== queue.actorUid || s.authEpoch !== tokenEpoch) throw new QueueStopped();
      task.attempted = true;
      s.lastPostAt = Date.now();
    });
    submitted = true;
    await blockUser(initialTask.uid, csrf);
    writeSucceeded = true;
    let confirmed = await confirmedRelation(initialTask.uid, queue.actorUid);
    if (!confirmed.blocked) { await sleep(500); confirmed = await confirmedRelation(initialTask.uid, queue.actorUid); }
    await finishTask(queueId, taskId, confirmed.blocked ? 'blocked' : 'failed', confirmed.blocked ? '' : '请求已提交，但尚未确认拉黑关系，请稍后手动重试', confirmed.epoch);
  } catch (error) {
    if (error instanceof QueueStopped) {
      await update(s => {
        const task = s.queue?.id === queueId && s.queue.tasks.find(t => t.id === taskId);
        if (task?.status === 'processing' && !task.attempted) task.status = 'queued';
      });
      return;
    }
    if (error.pause) {
      await update(s => {
        if (s.queue?.id !== queueId) return;
        const task = s.queue.tasks.find(t => t.id === taskId);
        if (s.queue.cancelRequested) {
          if (task?.attempted) recordUncertainCancellation(s, task);
          else if (task) task.status = 'cancelled';
          return;
        }
        s.queue.paused = true;
        s.queue.reason = error.message;
        if (task?.status !== 'cancelled') {
          task.status = 'queued';
          task.error = error.message;
          // A previously uncertain submission remains uncertain even if a later read is rejected.
          task.attempted = wasSubmitted || (submitted && (writeSucceeded || Boolean(error.uncertain)));
        }
      });
      return;
    }
    if (submitted) {
      try {
        const relation = await confirmedRelation(initialTask.uid, queue.actorUid);
        if (relation.blocked) {
          await finishTask(queueId, taskId, 'blocked', '', relation.epoch);
          return;
        }
      } catch { /* Keep an explicit uncertain result; do not repeat a write. */ }
    }
    await finishTask(queueId, taskId, 'failed', submitted ? `${error.message}；提交结果未确认，可手动重试` : error.message);
  }
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (true) {
      const s = await snapshot();
      if (!s.queue || s.queue.paused) break;
      const task = s.queue.tasks.find(taskActive);
      if (!task) break;
      await runTask(s.queue, task);
    }
  } finally {
    queueRunning = false;
    await refreshBadges();
    await configureWatchdog();
  }
}

function kick() {
  void resolvePending().catch(() => {});
  void runQueue().catch(() => {});
}

async function startBlock(message) {
  if (!Number.isInteger(message.tabId) || !Array.isArray(message.candidateIds) ||
      !message.candidateIds.length || message.candidateIds.length > 1000) throw new Error('请选择有效的 UP 主');
  const tab = await chrome.tabs.get(message.tabId);
  if (!tab.active) throw new Error('当前标签页已变化，请重新打开弹窗');
  const account = await refreshAccount();
  if (!account.loggedIn) throw new ApiError(account.error || '请先登录 B 站', { code: 'LOGIN_REQUIRED' });
  await update(s => {
    const page = currentPage(s, message.tabId, message.pageId);
    if (!page || routeOf(tab.url) !== page.route) throw new Error('页面已变化，请查看最新名单后再操作');
    if (!s.account?.loggedIn || s.account.uid !== account.uid) throw new Error('登录状态已变化，请刷新后重试');
    if (s.queue?.tasks.some(taskActive)) throw new Error('请先完成或取消当前批次');
    const ids = [...new Set(message.candidateIds)];
    const candidates = ids.map(id => page.candidates.find(c => c.id === id));
    if (candidates.some(c => !c?.uid || !['pending', 'failed'].includes(candidateView(c, s).status))) throw new Error('名单状态已更新，请重新选择');
    s.queue = { id: crypto.randomUUID(), actorUid: account.uid, paused: false, reason: '', cancelRequested: false,
      tasks: candidates.map(c => ({ id: crypto.randomUUID(), uid: c.uid, name: c.name,
        tabId: message.tabId, pageId: page.id, status: 'queued', error: '', attempted: false })) };
  });
  await configureWatchdog();
  await refreshBadges();
  kick();
  return { ok: true };
}

async function getState(message) {
  if (!Number.isInteger(message.tabId)) return { ok: true, supported: false, page: null, account: null, queue: null };
  let tab;
  try { tab = await chrome.tabs.get(message.tabId); } catch { return { ok: true, supported: false, page: null }; }
  const route = routeOf(tab.url);
  await update(s => {
    const page = s.pages[message.tabId];
    if (!route || page?.route !== route) return;
    page.announcedUids = [...new Set([...page.announcedUids, ...page.candidates.filter(c => c.uid).map(c => c.uid)])];
    page.popupPending = false;
  });
  const s = await snapshot();
  const page = s.pages[message.tabId];
  return { ok: true, supported: Boolean(route), account: s.account, queue: queueSummary(s.queue),
    page: route && page?.route === route ? { id: page.id, url: page.url,
      candidates: page.candidates.map(c => candidateView(c, s)) } : null };
}

async function dispatch(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('无效的请求');
  if (message.type === 'PAGE_HELLO') return hello(message, sender);
  if (message.type === 'DETECTED') return detected(message, sender);
  if (!isPopup(sender)) throw new Error('操作只能由插件弹窗发起');
  switch (message.type) {
    case 'GET_STATE': return getState(message);
    case 'REFRESH_ACCOUNT': return { ok: true, account: await refreshAccount() };
    case 'BLOCK': return startBlock(message);
    case 'RESUME_QUEUE': {
      const account = await refreshAccount();
      await update(s => {
        if (!s.queue?.tasks.some(taskActive)) throw new Error('没有可继续的任务');
        if (!account.loggedIn || account.uid !== s.queue.actorUid) throw new Error('请切回提交批次时的 B 站账号，或取消剩余任务');
        s.queue.paused = false;
        s.queue.reason = '';
      });
      await configureWatchdog();
      kick();
      return { ok: true };
    }
    case 'CANCEL_QUEUE':
      await update(s => {
        if (!s.queue) return;
        s.queue.cancelRequested = true;
        s.queue.paused = false;
        s.queue.reason = '已取消尚未提交的任务';
        for (const task of s.queue.tasks) {
          if (task.status === 'queued' && task.attempted) recordUncertainCancellation(s, task);
          else if (taskActive(task) && !task.attempted) task.status = 'cancelled';
        }
      });
      await configureWatchdog();
      await refreshBadges();
      kick();
      return { ok: true };
    default: throw new Error('不支持的操作');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  dispatch(message, sender).then(respond, error => respond({ ok: false, error: error.message || '操作失败', code: error.code || 'ERROR' }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  clearTimeout(popupTimers.get(String(tabId)));
  clearTimeout(popupTimers.get(tabId));
  popupTimers.delete(String(tabId));
  popupTimers.delete(tabId);
  void update(s => { delete s.pages[tabId]; }).then(configureWatchdog).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== 'loading') return;
  void update(s => {
    const page = s.pages[tabId];
    if (page && (change.status === 'loading' || routeOf(change.url || tab.url) !== page.route)) delete s.pages[tabId];
  }).then(() => refreshBadge(tabId)).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => { schedulePopup(String(tabId)); });
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId < 0) return;
  void chrome.tabs.query({ active: true, windowId }).then(tabs => {
    if (tabs[0]) schedulePopup(String(tabs[0].id));
  }).catch(() => {});
});

chrome.cookies.onChanged.addListener(change => {
  if (!/(^|\.)bilibili\.com$/.test(change.cookie.domain) || !['SESSDATA', 'DedeUserID'].includes(change.cookie.name)) return;
  void update(s => {
    s.authEpoch += 1;
    s.account = null;
    if (s.queue?.tasks.some(taskActive)) {
      s.queue.paused = true;
      s.queue.reason = 'B 站登录状态发生变化，请刷新登录状态后继续';
    }
  }).then(refreshBadges).catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === WATCHDOG) kick();
});
chrome.runtime.onStartup.addListener(() => { kick(); });
chrome.runtime.onInstalled.addListener(() => { kick(); });

void ready.then(async () => {
  const tabs = await chrome.tabs.query({});
  const ids = new Set(tabs.map(tab => String(tab.id)));
  await update(s => {
    for (const id of Object.keys(s.pages)) if (!ids.has(id)) delete s.pages[id];
  });
  for (const tab of tabs) schedulePopup(String(tab.id));
  await configureWatchdog();
  kick();
}).catch(() => {});
