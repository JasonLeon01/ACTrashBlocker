export const SITE = 'https://www.bilibili.com';
export const API = 'https://api.bilibili.com';
export const STORAGE_KEY = 'promoBlockerSessionV1';
export const POPUP_COOLDOWN = 10_000;

export function uid(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const text = String(value ?? '');
  return /^[1-9]\d{0,19}$/.test(text) ? text : null;
}

export function routeOf(value) {
  try {
    const url = new URL(value);
    if (url.origin !== SITE) return null;
    if (url.pathname === '/') return '/';
    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d*)\/?$/i);
    return match ? `/video/${match[1]}` : null;
  } catch { return null; }
}

export function normalizeVideo(value) {
  if (!value || typeof value !== 'object') return null;
  let bvid = typeof value.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/.test(value.bvid) ? value.bvid : null;
  let aid = uid(value.aid);
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com'].includes(url.hostname) || url.port) return null;
    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av([1-9]\d*))\/?$/);
    if (!match) return null;
    if (match[2]) {
      if (aid && aid !== match[2]) return null;
      aid = match[2];
    } else {
      if (bvid && bvid !== match[1]) return null;
      bvid = match[1];
    }
  } catch { return null; }
  if (!bvid && !aid) return null;
  return { ...(bvid ? { bvid } : {}), ...(aid ? { aid } : {}),
    url: `${SITE}/video/${bvid || `av${aid}`}/`, title: String(value.title || '查看来源视频').slice(0, 240) };
}

export function videoKey(video) { return video.bvid ? `bv:${video.bvid}` : `av:${video.aid}`; }

export function evidenceList(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(x => typeof x === 'string')
    .map(x => x.trim().slice(0, 160)).filter(Boolean))].slice(0, 8);
}

export function mergeEvidence(a, b) { return evidenceList([...a, ...b]); }

export function mergeVideos(a, b) {
  const videos = new Map(a.map(v => [videoKey(v), v]));
  for (const video of b) videos.set(videoKey(video), video);
  return [...videos.values()];
}

export function emptyState() {
  return { version: 1, pages: {}, account: null, authEpoch: 0, queue: null, videoCache: {}, lastPostAt: 0, lastPopupAt: 0 };
}

export function taskActive(task) { return ['queued', 'processing'].includes(task.status); }

export function queueSummary(queue) {
  if (!queue) return null;
  const pending = queue.tasks.filter(taskActive).length;
  return { running: pending > 0 && !queue.paused, paused: pending > 0 && queue.paused,
    reason: queue.reason || '', total: queue.tasks.length,
    done: queue.tasks.filter(t => !taskActive(t)).length,
    succeeded: queue.tasks.filter(t => t.status === 'blocked').length,
    failed: queue.tasks.filter(t => t.status === 'failed').length,
    cancelled: queue.tasks.filter(t => t.status === 'cancelled').length, pending };
}

export function candidateView(candidate, state) {
  const result = { id: candidate.id, uid: candidate.uid || null, name: candidate.name || '无法识别 UP 主',
    evidence: candidate.evidence, videos: candidate.videos, status: candidate.status, error: candidate.error || '' };
  if (!candidate.uid) return result;
  result.status = state.account?.loggedIn && candidate.blockedFor === state.account.uid ? 'blocked' : 'pending';
  result.error = '';
  if (state.account?.loggedIn && candidate.lastResult?.actorUid === state.account.uid) {
    result.status = candidate.lastResult.status;
    result.error = candidate.lastResult.error;
  }
  if (state.queue && state.account?.loggedIn && state.queue.actorUid === state.account.uid) {
    const task = state.queue.tasks.find(t => t.uid === candidate.uid);
    if (task && task.status !== 'cancelled') {
      result.status = task.status;
      result.error = task.error || '';
    }
  }
  return result;
}
