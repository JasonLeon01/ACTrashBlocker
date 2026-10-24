/* Site adapters deliberately use explicit promotion markers, never title keywords. */
(() => {
  "use strict";

  const CARD_SELECTOR = [
    ".bili-video-card", ".video-page-card-small", ".video-card-ad-small",
    ".video-page-game-card-small", ".recommend-video-card", ".card-box",
    ".feed-card", ".floor-single-card", ".video-page-special-card-small",
    ".ad-report", ".ad-floor-cover", ".strip-ad", "#slide_ad",
  ].join(",");
  const NON_LAYOUT_CARD_SELECTOR = CARD_SELECTOR.split(",").filter(selector => selector !== ".card-box").join(",");
  const MARKERS = [
    [".bili-video-card__info--creative-ad", "小火箭推广标记"],
    [".bili-video-card__info--ad", "广告标记"],
    [".video-card-ad-small", "视频页推广卡片"],
    [".video-page-game-card-small", "视频页游戏广告卡片"],
    ["#slide_ad, .ad-report, .ad-floor-cover, .strip-ad", "页面广告位"],
  ];
  const TEXT_MARKERS = [
    ".bili-video-card__stats--text", ".bili-video-card__info--rcmd-text",
    ".ad-label", ".ad-tag", ".ad-mark", ".advertisement-label",
  ].join(",");
  const EXPLICIT_TEXT = /^(?:广告|推广|商业推广|商业合作|付费推广)$/u;
  const MAIN_TEXT = /^(?:(?:本|该)?(?:视频|内容)(?:中)?)?(?:含有|包含|含)?商业(?:推广|合作)(?:信息|内容)?$/u;
  const MAIN_METADATA = [
    ".video-info-detail", ".video-argue", ".video-info-container .argue",
    "#viewbox_report .argue", ".video-desc-container .argue",
  ].join(",");
  const VIDEO_HOSTS = new Set(["www.bilibili.com", "bilibili.com", "m.bilibili.com"]);
  const TARGET_PARAMS = ["url", "target_url", "target", "redirect_url", "jump_url", "landing_url", "landingpage_url"];
  const mainMarkerHistory = new WeakMap();
  const PRIMARY_LINKS = [
    "a.bili-video-card__image--link", ".bili-video-card__image a[href]",
    ".bili-video-card__info--tit a[href]", "a.bili-video-card__info--tit",
    "a.pic", ".pic a[href]", "a.cover", ".cover a[href]",
    "a.title", ".title a[href]", "h3 a[href]", "h4 a[href]",
  ].join(",");

  const text = (value, max = 200) => String(value || "").replace(/\s+/gu, " ").trim().slice(0, max);

  function toURL(raw, base) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 12000) return null;
    let value = raw.trim();
    for (let i = 0; i < 3 && /^(?:https?%3a|%2f%2f)/iu.test(value); i += 1) {
      try { value = decodeURIComponent(value); } catch { return null; }
    }
    try {
      const url = new URL(value, base);
      return ["http:", "https:"].includes(url.protocol) ? url : null;
    } catch { return null; }
  }

  function videoFromURL(raw, base = "https://www.bilibili.com/", depth = 0) {
    // Loading placeholders must not resolve to the currently playing video's URL.
    if (typeof raw !== "string" || /^[?#]/u.test(raw.trim()) || /^(?:\.\.?\/?)$/u.test(raw.trim())) return null;
    const url = toURL(raw, base);
    if (!url || depth > 3) return null;
    if (url.hostname === "cm.bilibili.com") {
      const destinations = [];
      for (const param of TARGET_PARAMS) {
        for (const nested of url.searchParams.getAll(param)) {
          if (!nested) continue;
          const video = videoFromURL(nested, base, depth + 1);
          // A game/product landing page must not fall through to a different
          // query parameter that happens to contain a video URL.
          if (!video) return null;
          destinations.push(video);
        }
      }
      const unique = new Map(destinations.map(video => [videoKey(video), video]));
      return unique.size === 1 ? [...unique.values()][0] : null;
    }
    if (!VIDEO_HOSTS.has(url.hostname)) return null;
    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d{0,17})\/?$/u);
    if (!match) return null;
    const id = match[1];
    return id.startsWith("BV")
      ? { bvid: id, url: `https://www.bilibili.com/video/${id}/` }
      : { aid: id.slice(2), url: `https://www.bilibili.com/video/${id}/` };
  }

  function videoKey(video) {
    return video.bvid ? `bv:${video.bvid}` : `av:${video.aid}`;
  }

  function pageKey(raw) {
    const url = toURL(raw, "https://www.bilibili.com/");
    if (!url || url.hostname !== "www.bilibili.com") return null;
    if (url.pathname === "/") return "home";
    const video = videoFromURL(url.href);
    return video ? `${videoKey(video)}:p${url.searchParams.get("p") || "1"}` : null;
  }

  function matchesIncludingRoot(root, selector) {
    const matches = [...root.querySelectorAll(selector)];
    if (root.nodeType === 1 && root.matches(selector)) matches.unshift(root);
    return matches;
  }

  function visible(element) {
    if (!element?.isConnected || element.closest("[hidden], [aria-hidden='true'], template")) return false;
    if (element.getClientRects().length === 0) return false;
    const view = element.ownerDocument.defaultView;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = view.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    }
    return true;
  }

  function findCard(marker) {
    return marker.closest(CARD_SELECTOR);
  }

  function belongsTo(card, element) {
    // A nested recommendation/ad must not contribute the surrounding video's identity.
    const nearest = findCard(element);
    if (nearest === card) return true;
    // The immediate card-box of a standard small video card is a layout shell,
    // not permission to cross arbitrary nested advertising/recommendation cards.
    return nearest?.parentElement === card && nearest.matches(".card-box") &&
      !nearest.matches(NON_LAYOUT_CARD_SELECTOR) &&
      card.matches(".video-page-card-small, .video-card-ad-small");
  }

  function cmDestinationParameters(node, base) {
    const url = toURL(node.getAttribute("href"), base);
    return url?.hostname === "cm.bilibili.com" && TARGET_PARAMS.some(param => url.searchParams.has(param));
  }

  function targetVideo(node, base) {
    const href = node.getAttribute("href");
    if (!node.hasAttribute("data-target-url")) return videoFromURL(href, base);
    const video = videoFromURL(node.getAttribute("data-target-url"), base);
    if (!video) return null;
    const hrefURL = toURL(href, base);
    if (hrefURL && !href.trim().startsWith("#") && (hrefURL.hostname !== "cm.bilibili.com" || cmDestinationParameters(node, base))) {
      const linkedVideo = videoFromURL(href, base);
      if (!linkedVideo || videoKey(linkedVideo) !== videoKey(video)) return null;
    }
    return video;
  }

  function extractVideo(card, base) {
    const scoped = matchesIncludingRoot(card, "a[href], [data-target-url]")
      .filter(node => belongsTo(card, node) && visible(node));
    const explicitTargets = scoped.filter(node => node.hasAttribute("data-target-url"));
    const adLinks = scoped.filter(node => toURL(node.getAttribute("href"), base)?.hostname === "cm.bilibili.com");
    let targets;
    if (explicitTargets.length) {
      // Explicit non-video destinations veto a candidate. Do not search an
      // unrelated title/thumbnail link after a game or product target fails.
      targets = [...new Set([...explicitTargets, ...adLinks.filter(node => cmDestinationParameters(node, base))])];
    } else if (adLinks.length) {
      targets = adLinks;
    } else {
      const links = scoped.filter(node => node.matches("a[href]"));
      const primary = links.filter(node => node.matches(PRIMARY_LINKS));
      targets = primary.length ? primary : links.filter(node => {
        const href = node.getAttribute("href")?.trim() || "";
        if (!href || href.startsWith("#") || /^javascript:\s*(?:void\(0\)|;)?\s*;?$/iu.test(href)) return false;
        const url = toURL(href, base);
        // A creator profile is ancillary to the video card's destination.
        return !(url?.hostname === "space.bilibili.com" && /^\/[1-9]\d*\/?$/u.test(url.pathname));
      });
    }
    const choices = new Map();
    for (const node of targets) {
      const video = targetVideo(node, base);
      if (!video) return null;
      const title = text(node.getAttribute("title") || node.querySelector("img")?.getAttribute("alt") || node.textContent);
      const key = videoKey(video);
      const existing = choices.get(key);
      if (!existing || (!existing.title && title)) choices.set(key, { ...video, title });
    }
    if (choices.size !== 1) return null;
    const video = [...choices.values()][0];
    const heading = card.querySelector(".bili-video-card__info--tit, .title, h3, h4");
    if (heading && belongsTo(card, heading) && visible(heading)) video.title = text(heading.getAttribute("title") || heading.textContent) || video.title;
    return video;
  }

  function mainVideoCandidates(doc, base) {
    const current = videoFromURL(base);
    if (!current) return [];
    const canonicalNodes = [...doc.querySelectorAll("link[rel='canonical'], meta[property='og:url'], meta[itemprop='url']")];
    const declared = canonicalNodes.map(node => videoFromURL(node.getAttribute("href") || node.getAttribute("content"), base)).filter(Boolean);
    // During SPA navigation an old disclosure can briefly remain in the DOM. Require
    // a matching document video identity before associating any main-video label.
    if (!declared.length || declared.some(video => videoKey(video) !== videoKey(current))) return [];
    const evidence = new Set();
    for (const metadata of doc.querySelectorAll(MAIN_METADATA)) {
      if (metadata.closest(CARD_SELECTOR)) continue;
      for (const marker of matchesIncludingRoot(metadata, "span, p, div, a")) {
        if (marker.children.length || !visible(marker)) continue;
        const label = text(marker.textContent, 60).replace(/\s/gu, "");
        if (!MAIN_TEXT.test(label)) continue;
        const previous = mainMarkerHistory.get(marker);
        const key = videoKey(current);
        // A router may update canonical metadata before replacing the visible
        // disclosure. Do not carry an unchanged old label onto another uploader.
        if (previous && previous.key !== key && previous.label === label) continue;
        mainMarkerHistory.set(marker, { key, label });
        evidence.add(`主视频标注：${label}`);
      }
    }
    if (!evidence.size) return [];
    const heading = doc.querySelector("#viewbox_report h1, h1.video-title, .video-info-container h1");
    return [{ key: videoKey(current), video: { ...current, title: text(heading?.getAttribute("title") || heading?.textContent) }, evidence: [...evidence] }];
  }

  function scan(root = document, base = root.ownerDocument?.URL || root.URL) {
    if (!pageKey(base)) return [];
    // A late href update may be observed inside the standard small-card layout
    // shell, while its promotion class lives on the immediate parent card.
    if (root.nodeType === 1 && root.matches(".card-box") &&
      root.parentElement?.matches(".video-page-card-small, .video-card-ad-small") &&
      belongsTo(root.parentElement, root)) root = root.parentElement;
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const cards = new Map();
    const add = (marker, evidence) => {
      if (!visible(marker)) return;
      const card = findCard(marker);
      if (!card || !visible(card)) return;
      if (!cards.has(card)) cards.set(card, { evidence: new Set() });
      cards.get(card).evidence.add(evidence);
    };
    for (const [selector, evidence] of MARKERS) {
      for (const marker of matchesIncludingRoot(root, selector)) add(marker, evidence);
    }
    for (const marker of matchesIncludingRoot(root, TEXT_MARKERS)) {
      const label = text(marker.textContent, 40);
      if (EXPLICIT_TEXT.test(label)) add(marker, `明确标记：${label}`);
    }
    for (const link of matchesIncludingRoot(root, "a[href*='cm.bilibili.com' i]")) {
      if (toURL(link.getAttribute("href"), base)?.hostname === "cm.bilibili.com") {
        add(link, "B 站广告推广链接");
      }
    }
    const result = [];
    for (const [card, marker] of cards) {
      const video = extractVideo(card, base);
      if (!video) continue;
      result.push({
        key: videoKey(video),
        video,
        evidence: [...marker.evidence],
      });
    }
    result.push(...mainVideoCandidates(doc, base));
    return result;
  }

  globalThis.BiliPromoDetector = Object.freeze({ scan, pageKey, videoFromURL, videoKey, CARD_SELECTOR, MAIN_METADATA });
})();
