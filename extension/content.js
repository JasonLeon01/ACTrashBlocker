(() => {
  "use strict";
  const detector = globalThis.BiliPromoDetector;
  if (!detector || window.top !== window) return;

  let stopped = false;
  let page = null;
  let sequence = 0;
  let scanTimer = null;
  let flushTimer = null;
  let routeTimer = null;
  let sending = false;
  let retryDelay = 1000;
  let needsFullScan = false;
  const roots = new Set();
  const hiddenAds = new Set();
  const HIDDEN_ATTRIBUTE = "data-actrashblocker-hidden";
  const MAX_BATCH = 40;

  function contextGone(error) {
    return !chrome.runtime?.id || /extension context invalidated/iu.test(String(error?.message || error));
  }

  function restoreAds() {
    for (const element of hiddenAds) element.removeAttribute(HIDDEN_ATTRIBUTE);
    hiddenAds.clear();
  }

  function releaseDetachedAds() {
    for (const element of hiddenAds) {
      if (element.isConnected) continue;
      element.removeAttribute(HIDDEN_ATTRIBUTE);
      hiddenAds.delete(element);
    }
    updateAdCount();
  }

  function updateAdCount() {
    if (stopped || !page?.supported || page.hiddenAdCount === hiddenAds.size) return;
    page.hiddenAdCount = hiddenAds.size;
    scheduleFlush();
  }

  function needsAdStats(snapshot) {
    return Boolean(snapshot?.supported && snapshot.hiddenAdCount !== snapshot.sentHiddenAdCount);
  }

  function stop() {
    stopped = true;
    observer.disconnect();
    clearTimeout(scanTimer);
    clearTimeout(flushTimer);
    clearInterval(routeTimer);
    document.removeEventListener("load", resourceLoaded, true);
    roots.clear();
    restoreAds();
  }

  function scheduleFlush(delay = 400) {
    if (stopped || flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, delay);
  }

  function resynchronize(snapshot) {
    snapshot.hello = false;
    snapshot.sent.clear();
    snapshot.sentHiddenAdCount = null;
    for (const [key, item] of snapshot.known) snapshot.pending.set(key, item);
  }

  async function flush() {
    if (stopped || sending || !page) return;
    sending = true;
    const snapshot = page;
    try {
      if (!snapshot.hello) {
        const reply = await chrome.runtime.sendMessage({ type: "PAGE_HELLO", pageId: snapshot.id, url: snapshot.url });
        if (!reply?.ok) throw new Error(reply?.error || "后台尚未就绪");
        if (snapshot !== page) return;
        snapshot.hello = true;
      }
      if (needsAdStats(snapshot)) {
        const hiddenAdCount = snapshot.hiddenAdCount;
        const reply = await chrome.runtime.sendMessage({ type: "AD_STATS", pageId: snapshot.id, url: snapshot.url, hiddenAdCount });
        if (reply?.code === "PAGE_STALE") resynchronize(snapshot);
        if (!reply?.ok) throw new Error(reply?.error || "广告拦截数量同步失败");
        if (snapshot !== page) return;
        // A scan can change the count while this message is in flight.
        snapshot.sentHiddenAdCount = hiddenAdCount;
      }
      if (snapshot.pending.size) {
        const batch = [...snapshot.pending.values()].slice(0, MAX_BATCH);
        const reply = await chrome.runtime.sendMessage({ type: "DETECTED", pageId: snapshot.id, url: snapshot.url, items: batch });
        if (reply?.code === "PAGE_STALE") resynchronize(snapshot);
        if (!reply?.ok) throw new Error(reply?.error || "候选上报失败");
        if (snapshot !== page) return;
        for (const item of batch) {
          const fingerprint = JSON.stringify(item);
          snapshot.sent.set(item.key, fingerprint);
          if (JSON.stringify(snapshot.pending.get(item.key)) === fingerprint) snapshot.pending.delete(item.key);
        }
      }
      retryDelay = 1000;
    } catch (error) {
      if (contextGone(error)) { stop(); return; }
      scheduleFlush(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    } finally {
      sending = false;
      if (!stopped && (page !== snapshot || (!flushTimer && (page?.pending.size || needsAdStats(page))))) scheduleFlush();
    }
  }

  function routeChanged() {
    if (stopped) return false;
    if (!chrome.runtime?.id) { stop(); return false; }
    const key = detector.pageKey(location.href);
    const route = key || `unsupported:${location.pathname}`;
    if (page?.route === route) return false;
    restoreAds();
    page = {
      id: `${crypto.randomUUID()}-${++sequence}`,
      route,
      url: location.href,
      supported: Boolean(key),
      hello: false,
      hiddenAdCount: 0,
      sentHiddenAdCount: null,
      sent: new Map(),
      pending: new Map(),
      known: new Map(),
    };
    roots.clear();
    needsFullScan = true;
    clearTimeout(scanTimer);
    scanTimer = null;
    scheduleFlush(0);
    if (page.supported) scheduleScan(document, 600);
    return true;
  }

  function scheduleScan(root, delay = 600) {
    if (stopped || !page?.supported) return;
    if (root === document || roots.size > 40) { needsFullScan = true; roots.clear(); }
    else if (!needsFullScan && root?.nodeType === 1) roots.add(root);
    if (scanTimer) return;
    scanTimer = setTimeout(runScan, delay);
  }

  function runScan() {
    scanTimer = null;
    if (routeChanged() || stopped || !page?.supported) return;
    const snapshot = page;
    // Recheck our hidden nodes even if the site has removed their card classes.
    // All inspection and hiding stays synchronous, so no intermediate frame is painted.
    const candidates = needsFullScan ? [document] : [...new Set([...roots, ...hiddenAds])]
      .filter(root => root.isConnected);
    const targets = candidates.filter(root => !candidates.some(other => other !== root && other.contains(root)));
    restoreAds();
    needsFullScan = false;
    roots.clear();
    const displayAds = new Set();
    for (const root of targets) {
      for (const item of detector.scan(root, snapshot.url)) {
        const previous = snapshot.known.get(item.key);
        if (previous) item.evidence = [...new Set([...previous.evidence, ...item.evidence])];
        snapshot.known.set(item.key, item);
        if (snapshot.sent.get(item.key) !== JSON.stringify(item)) snapshot.pending.set(item.key, item);
      }
      for (const element of detector.scanDisplayAds(root, snapshot.url)) displayAds.add(element);
    }
    // Finish every video scan first: hiding one root must not suppress a candidate
    // in another root, or hide main-video metadata inspected by the detector.
    for (const element of displayAds) {
      if (!element.isConnected) continue;
      element.setAttribute(HIDDEN_ATTRIBUTE, "");
      hiddenAds.add(element);
    }
    updateAdCount();
    if (snapshot.pending.size) scheduleFlush();
  }

  function resourceLoaded(event) {
    const element = event.target;
    if (element?.nodeType !== 1 || !element.matches("img, iframe")) return;
    if (routeChanged() || stopped || !page?.supported) return;
    const scope = element.closest(`${detector.CARD_SELECTOR},[${HIDDEN_ATTRIBUTE}]`);
    if (scope) scheduleScan(scope);
  }

  const observer = new MutationObserver(records => {
    if (routeChanged() || stopped || !page?.supported) return;
    releaseDetachedAds();
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!element) continue;
      const scope = element.closest(`${detector.CARD_SELECTOR},${detector.MAIN_METADATA},[${HIDDEN_ATTRIBUTE}]`);
      if (scope) scheduleScan(scope);
      else if (record.type === "childList") {
        for (const node of record.addedNodes) if (node.nodeType === 1) scheduleScan(node);
      } else if (record.type === "attributes") scheduleScan(element);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    // Our hiding attribute is deliberately excluded to avoid observing our own writes.
    attributeFilter: ["id", "class", "style", "hidden", "aria-hidden", "href", "data-target-url", "content", "src", "srcset"],
  });
  // Image completion changes naturalWidth without a DOM mutation. Capture load
  // because resource load events do not bubble to the document.
  document.addEventListener("load", resourceLoaded, true);
  routeChanged();
  if (!stopped) routeTimer = setInterval(routeChanged, 1000);
  window.addEventListener("popstate", routeChanged);
  window.addEventListener("hashchange", routeChanged);
  window.addEventListener("pagehide", event => { if (!event.persisted) stop(); });
  window.addEventListener("pageshow", event => {
    if (routeChanged() || stopped) return;
    if (event.persisted && page) { resynchronize(page); scheduleFlush(0); }
    scheduleScan(document, 100);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { routeChanged(); scheduleScan(document, 100); }
  });
})();
