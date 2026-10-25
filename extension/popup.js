const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  'count-badge', 'account', 'account-text', 'login-link', 'refresh-account',
  'ad-summary', 'ad-summary-text',
  'notice', 'notice-text', 'dismiss-notice', 'queue', 'queue-title', 'queue-count',
  'queue-progress', 'queue-detail', 'queue-actions', 'resume-queue', 'cancel-queue',
  'main', 'empty-state', 'empty-title', 'empty-description', 'list-heading',
  'list-meta', 'candidates', 'block-all', 'footer-note',
].map((id) => [id, $(id)]));

let tabId = null;
let state = null;
let stateConnected = false;
let refreshing = false;
let actionPending = false;
let accountPending = false;
let renderSignature = '';
let currentPageId = null;
let disposed = false;
const expandedSources = new Set();

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function validUid(uid) {
  return /^[1-9]\d{0,19}$/.test(String(uid ?? ''));
}

function videoHref(video) {
  if (/^BV[0-9A-Za-z]{10}$/.test(String(video?.bvid ?? ''))) {
    return `https://www.bilibili.com/video/${video.bvid}/`;
  }
  if (/^[1-9]\d{0,19}$/.test(String(video?.aid ?? ''))) {
    return `https://www.bilibili.com/video/av${video.aid}/`;
  }
  try {
    const url = new URL(video?.url);
    if (url.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d{0,19})\/?$/);
    return match ? `https://www.bilibili.com/video/${match[1]}/` : null;
  } catch {
    return null;
  }
}

function externalLink(label, href, className) {
  const anchor = node('a', className, label);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response || response.ok !== true) {
    const error = new Error(text(response?.error, '操作未完成，请稍后重试。'));
    error.code = response?.code;
    throw error;
  }
  return response;
}

function showNotice(message, kind = 'info') {
  elements['notice-text'].textContent = message;
  elements.notice.dataset.kind = kind;
  elements.notice.hidden = !message;
}

function queueBusy() {
  return Boolean(state?.queue?.running || state?.queue?.paused);
}

function accountAllowsBlocking() {
  return Boolean(state?.account?.loggedIn) && state.account.verified !== false;
}

function actionable(candidate) {
  return validUid(candidate.uid) && ['pending', 'failed'].includes(candidate.status);
}

function eligibleCandidates() {
  return (state?.supported ? state.page?.candidates ?? [] : []).filter(actionable);
}

function renderAccount() {
  const account = state?.account;
  elements['refresh-account'].disabled = accountPending || actionPending;
  elements['refresh-account'].textContent = accountPending ? '检查中…' : '刷新';
  elements['login-link'].hidden = accountPending || !account || account.verified === false || Boolean(account.loggedIn);
  if (accountPending || !account) {
    elements.account.dataset.state = 'checking';
    elements['account-text'].textContent = accountPending ? '正在检查登录状态…' : '尚未确认登录状态';
  } else if (account.verified === false) {
    elements.account.dataset.state = 'unverified';
    const cachedName = account.loggedIn ? ` · ${text(account.name, `UID ${account.uid}`)}` : '';
    const reason = text(account.error);
    elements['account-text'].textContent = `登录状态暂无法验证${cachedName}${reason ? `：${reason}` : ''}`;
  } else if (account.loggedIn) {
    elements.account.dataset.state = 'logged-in';
    elements['account-text'].textContent = `已登录 · ${text(account.name, `UID ${account.uid}`)}`;
  } else {
    elements.account.dataset.state = 'logged-out';
    elements['account-text'].textContent = text(account.error, '未登录，登录后可执行拉黑');
  }
  elements['account-text'].title = elements['account-text'].textContent;
}

function renderAdSummary() {
  const count = state?.page?.hiddenAdCount;
  const available = stateConnected && state?.supported && Number.isSafeInteger(count) && count >= 0;
  elements['ad-summary'].hidden = !available;
  elements['ad-summary-text'].textContent = available ? `当前页面已拦截 ${count} 个广告` : '';
}

function renderQueue() {
  const queue = state?.queue;
  elements.queue.hidden = !queue || !(queue.total > 0);
  if (elements.queue.hidden) return;
  if (queue.paused && elements.notice.dataset.kind === 'info') showNotice('');
  const total = Math.max(0, Number(queue.total) || 0);
  const done = Math.min(total, Math.max(0, Number(queue.done) || 0));
  const failed = Math.max(0, Number(queue.failed) || 0);
  elements['queue-title'].textContent = queue.paused ? '拉黑任务已暂停' : queue.running ? '正在逐个拉黑' : '本次任务已结束';
  elements['queue-count'].textContent = `${done} / ${total}`;
  elements['queue-progress'].max = Math.max(1, total);
  elements['queue-progress'].value = done;
  elements['queue-detail'].textContent = text(queue.reason, queue.running
    ? '关闭弹窗后会继续处理已提交的名单。'
    : failed ? `${failed} 项未成功，可在名单中查看原因。` : '可在 B 站黑名单设置中管理已拉黑的 UP 主。');
  elements['queue-actions'].hidden = !queue.paused && !queue.running;
  elements['resume-queue'].hidden = !queue.paused;
  elements['resume-queue'].disabled = actionPending || accountPending ||
    (state?.account?.verified !== false && !state?.account?.loggedIn);
  elements['cancel-queue'].disabled = actionPending;
}

function renderCandidate(candidate) {
  const card = node('article', 'candidate');
  card.dataset.status = candidate.status;
  const heading = node('div', 'candidate-heading');
  const name = text(candidate.name, candidate.uid ? `UP 主 ${candidate.uid}` : '暂时无法确认 UP 主');
  const avatar = node('span', 'avatar', candidate.status === 'blocked' ? '✓' : Array.from(name)[0]);
  avatar.setAttribute('aria-hidden', 'true');
  const identity = node('div', 'candidate-identity');
  const nameElement = validUid(candidate.uid)
    ? externalLink(name, `https://space.bilibili.com/${candidate.uid}`, 'candidate-name')
    : node('span', 'candidate-name', name);
  nameElement.title = name;
  identity.append(nameElement, node('p', 'candidate-uid', validUid(candidate.uid) ? `UID ${candidate.uid}` : '身份未确认'));
  const labels = { pending: '拉黑', queued: '排队中', processing: '处理中', blocked: '已拉黑', failed: '重试', unresolved: '不可拉黑' };
  const button = node('button', 'candidate-action', labels[candidate.status] ?? '不可拉黑');
  button.type = 'button';
  button.dataset.candidateId = candidate.id;
  button.disabled = actionPending || accountPending || queueBusy() || !accountAllowsBlocking() || !actionable(candidate);
  if (actionable(candidate) && state?.account?.verified === false) button.title = '登录状态暂无法验证，请刷新后重试';
  else if (actionable(candidate) && !state?.account?.loggedIn) button.title = '请先登录 B 站并刷新登录状态';
  else if (actionable(candidate) && queueBusy()) button.title = '请先完成或取消当前任务';
  else button.title = labels[candidate.status] ?? '身份未确认，无法拉黑';
  button.setAttribute('aria-label', `${labels[candidate.status] ?? '不可拉黑'} ${name}`);
  heading.append(avatar, identity, button);
  card.append(heading);

  const videos = (candidate.videos ?? []).map((video) => ({ video, href: videoHref(video) })).filter(({ href }) => href);
  if (videos.length) {
    const videoList = node('div', 'video-list');
    const makeVideo = ({ video, href }) => externalLink(text(video.title, video.bvid || (video.aid ? `av${video.aid}` : '查看来源视频')), href, 'video-link');
    videoList.append(makeVideo(videos[0]));
    if (videos.length > 1) {
      const details = node('details');
      details.dataset.candidateId = candidate.id;
      details.open = expandedSources.has(candidate.id);
      details.append(node('summary', '', `还有 ${videos.length - 1} 个来源视频`));
      videos.slice(1).forEach((video) => details.append(makeVideo(video)));
      details.addEventListener('toggle', () => {
        if (details.open) expandedSources.add(candidate.id);
        else expandedSources.delete(candidate.id);
      });
      videoList.append(details);
    }
    card.append(videoList);
  }

  const evidence = [...new Set((candidate.evidence ?? []).filter((item) => typeof item === 'string' && item.trim()))];
  if (evidence.length) {
    const list = node('div', 'evidence-list');
    evidence.forEach((item) => list.append(node('span', 'evidence', item)));
    card.append(list);
  }
  if (candidate.error || candidate.status === 'unresolved') {
    card.append(node('p', 'candidate-error', text(candidate.error, '未找到可核验的视频作者，不参与一键拉黑。')));
  }
  return card;
}

function render() {
  const signature = JSON.stringify([state, stateConnected, actionPending, accountPending]);
  if (signature === renderSignature) return;
  renderSignature = signature;
  renderAccount();
  renderAdSummary();
  renderQueue();
  const candidates = state?.supported ? state.page?.candidates ?? [] : [];
  const eligible = eligibleCandidates();
  const canAct = !actionPending && !accountPending && !queueBusy() && accountAllowsBlocking() && state?.supported;
  elements.main.setAttribute('aria-busy', String(!state));
  elements['count-badge'].textContent = `${eligible.length} 位待处理`;
  elements['block-all'].textContent = actionPending ? '正在提交…' : `一键拉黑全部（${eligible.length}）`;
  elements['block-all'].disabled = !canAct || eligible.length === 0;
  elements['footer-note'].textContent = state?.account?.verified === false
    ? '请点击上方“刷新”重新验证登录状态'
    : queueBusy()
      ? '请先完成或取消当前任务'
      : state?.account && !state.account.loggedIn
        ? '登录 B 站后，点击上方“刷新”'
        : '点击后加入 B 站账号黑名单';
  elements['list-heading'].hidden = candidates.length === 0;
  elements['list-meta'].textContent = `共 ${candidates.length} 项 · 按 UID 合并`;
  elements['empty-state'].hidden = candidates.length > 0;
  if (!state) {
    elements['empty-title'].textContent = '正在读取页面';
    elements['empty-description'].textContent = '稍等一下，正在整理推广名单。';
  } else if (!state.supported) {
    elements['empty-title'].textContent = '前往 B 站开始识别';
    elements['empty-description'].textContent = '支持 B 站首页和视频页。\n只识别小火箭、广告等明确推广标记。';
  } else if (!state.page) {
    elements['empty-title'].textContent = '等待页面连接';
    elements['empty-description'].textContent = '首次安装或更新后，请刷新当前 B 站页面。';
  } else {
    elements['empty-title'].textContent = '暂未发现推广 UP 主';
    elements['empty-description'].textContent = '浏览或向下滚动页面，发现明确推广后会自动提醒。普通视频不会加入名单。';
  }
  const scrollTop = elements.main.scrollTop;
  const focusedId = document.activeElement?.dataset?.candidateId;
  elements.candidates.replaceChildren(...candidates.map(renderCandidate));
  elements.main.scrollTop = scrollTop;
  if (focusedId) {
    const replacement = [...elements.candidates.querySelectorAll('button[data-candidate-id]')]
      .find((element) => element.dataset.candidateId === focusedId);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  }
}

async function refreshState() {
  if (refreshing || disposed || tabId === null) return;
  refreshing = true;
  try {
    const next = await send('GET_STATE', { tabId });
    if (disposed) return;
    const nextPageId = next.page?.id ?? null;
    if (currentPageId !== nextPageId) {
      expandedSources.clear();
      if (currentPageId !== null) showNotice('');
      currentPageId = nextPageId;
    }
    state = next;
    stateConnected = true;
    render();
  } catch (error) {
    if (!disposed) {
      stateConnected = false;
      render();
      showNotice(text(error.message, '无法连接插件后台，请重新打开弹窗。'), 'error');
      elements.main.setAttribute('aria-busy', 'false');
      if (!state) {
        elements['empty-title'].textContent = '暂时无法读取页面';
        elements['empty-description'].textContent = '请稍后重新打开插件，或刷新当前 B 站页面。';
      }
    }
  } finally {
    refreshing = false;
  }
}

async function refreshAccount() {
  if (accountPending) return;
  accountPending = true;
  render();
  try {
    const response = await send('REFRESH_ACCOUNT', Number.isInteger(tabId) ? { tabId } : {});
    if (state) state.account = response.account;
  } catch (error) {
    showNotice(text(error.message, '登录状态检查失败，请稍后重试。'), 'error');
  } finally {
    accountPending = false;
    render();
    await refreshState();
  }
}

async function runAction(type, payload = {}, successMessage = '') {
  if (actionPending) return;
  actionPending = true;
  showNotice('');
  render();
  try {
    await send(type, payload);
    if (successMessage) showNotice(successMessage);
  } catch (error) {
    showNotice(text(error.message, '操作失败，请稍后重试。'), 'error');
  } finally {
    actionPending = false;
    await refreshState();
    render();
  }
}

function blockCandidates(ids) {
  if (!state?.page || !accountAllowsBlocking() || queueBusy() || !ids.length) return;
  const currentIds = new Set(eligibleCandidates().map((candidate) => candidate.id));
  const candidateIds = [...new Set(ids)].filter((id) => currentIds.has(id));
  if (!candidateIds.length) return;
  void runAction('BLOCK', { tabId, pageId: state.page.id, candidateIds }, `已提交 ${candidateIds.length} 位 UP 主，处理结果会逐项更新。`);
}

elements.candidates.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-candidate-id]');
  if (button && !button.disabled) blockCandidates([button.dataset.candidateId]);
});
elements['block-all'].addEventListener('click', () => blockCandidates(eligibleCandidates().map((candidate) => candidate.id)));
elements['refresh-account'].addEventListener('click', () => void refreshAccount());
elements['dismiss-notice'].addEventListener('click', () => showNotice(''));
elements['resume-queue'].addEventListener('click', () => void runAction('RESUME_QUEUE'));
elements['cancel-queue'].addEventListener('click', () => void runAction('CANCEL_QUEUE', {}, '已取消未执行的任务，已完成的拉黑不会撤销。'));

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error('未找到当前标签页，请在 B 站页面中打开插件。');
    tabId = tab.id;
    await refreshState();
    await refreshAccount();
  } catch (error) {
    showNotice(text(error.message, '无法读取当前标签页。'), 'error');
    elements.main.setAttribute('aria-busy', 'false');
    elements['empty-title'].textContent = '未找到当前页面';
    elements['empty-description'].textContent = '请打开 B 站首页或视频页后，再打开插件。';
  }
}

const poll = setInterval(() => void refreshState(), 1000);
window.addEventListener('pagehide', () => {
  disposed = true;
  clearInterval(poll);
}, { once: true });
void initialize();
