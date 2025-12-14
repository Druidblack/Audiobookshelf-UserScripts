// ==UserScript==
// @name         Audiobookshelf → Wikipedia Author Photo
// @namespace    https://github.com/Druidblack/Audiobookshelf-UserScripts
// @version      0.1.0
// @description  On ABS author pages: find author on Wikipedia and set author image in Audiobookshelf
// @author       Druidblack
//
// @match        http://192.168.1.161:16378/*
//
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      wikipedia.org
// @connect      wikimedia.org
// @connect      *
//
// @downloadURL  https://github.com/Druidblack/Audiobookshelf-UserScripts/raw/main/Audiobookshelf_wiki_import_image.user.js
// @updateURL    https://github.com/Druidblack/Audiobookshelf-UserScripts/raw/main/Audiobookshelf_wiki_import_image.user.js
// ==/UserScript==

(function () {
  'use strict';

  // -----------------------------
  // Shared settings keys (same as your LitRes script)
  // -----------------------------
  const CFG = {
    baseUrl: 'lr_abs_base_url',
    token: 'lr_abs_token'
  };

  function normalizeBaseUrl(url) {
    return (url || '').trim().replace(/\/+$/, '');
  }

  function gmGet(key, def = '') {
    const v = GM_getValue(key);
    return (v === undefined || v === null || v === '') ? def : v;
  }

  function getBaseUrl() {
    // если не задано вручную — попробуем из origin
    return normalizeBaseUrl(gmGet(CFG.baseUrl, location.origin));
  }

  function getToken() {
    return gmGet(CFG.token, '');
  }

  GM_registerMenuCommand('ABS→Wikipedia: Settings', () => {
    const base = prompt('Audiobookshelf base URL', getBaseUrl());
    if (base !== null) GM_setValue(CFG.baseUrl, normalizeBaseUrl(base));

    const tok = prompt('Audiobookshelf API token (Bearer)', getToken());
    if (tok !== null) GM_setValue(CFG.token, tok.trim());

    alert('Сохранено. Обнови страницу автора.');
  });

  function authHeaders() {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // -----------------------------
  // Route guard (only /audiobookshelf/author/<uuid>)
  // -----------------------------
  const AUTHOR_UUID_RE =
    /^\/audiobookshelf\/author\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

  function isAuthorPage() {
    return AUTHOR_UUID_RE.test(location.pathname);
  }

  function getAuthorIdFromPath() {
    if (!isAuthorPage()) return '';
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  }

  // -----------------------------
  // GM request helpers
  // -----------------------------
  function gmRequest({ method = 'GET', url, headers = {}, data = null, responseType = 'json' }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        responseType,
        onload: resolve,
        onerror: reject,
        ontimeout: reject
      });
    });
  }

  async function getJson(url, headers = {}) {
    const res = await gmRequest({ method: 'GET', url, headers, responseType: 'json' });
    if (res.status >= 200 && res.status < 300) return res.response;
    throw new Error(`GET ${url} failed: ${res.status}`);
  }

  async function postJson(url, body, headers = {}) {
    const res = await gmRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', ...headers },
      data: JSON.stringify(body),
      responseType: 'json'
    });
    return res;
  }

  async function patchJson(url, body, headers = {}) {
    const res = await gmRequest({
      method: 'PATCH',
      url,
      headers: { 'Content-Type': 'application/json', ...headers },
      data: JSON.stringify(body),
      responseType: 'json'
    });
    return res;
  }

  // -----------------------------
  // ABS: apply author image (best-effort)
  // -----------------------------
  async function trySetAuthorImage(authorId, imageUrl) {
    const baseUrl = getBaseUrl();
    const headers = authHeaders();

    // 1) POST /api/authors/{id}/image { url }
    try {
      const res = await postJson(
        `${baseUrl}/api/authors/${encodeURIComponent(authorId)}/image`,
        { url: imageUrl },
        headers
      );
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, method: 'POST /authors/{id}/image {url}' };
      }
    } catch (_) {}

    // 2) PATCH /api/authors/{id} { imagePath: url }
    try {
      const res = await patchJson(
        `${baseUrl}/api/authors/${encodeURIComponent(authorId)}`,
        { imagePath: imageUrl },
        headers
      );
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, method: 'PATCH imagePath=url' };
      }
    } catch (_) {}

    return { ok: false, method: 'none' };
  }

  // -----------------------------
  // Wikipedia search + image
  // -----------------------------
  function wikiApiBase(lang) {
    return `https://${lang}.wikipedia.org`;
  }

  async function wikiSearchFirstTitle(lang, query) {
    const url =
      `${wikiApiBase(lang)}/w/api.php` +
      `?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
      `&srlimit=1&format=json`;

    const data = await getJson(url);
    const item = data?.query?.search?.[0];
    return item?.title || '';
  }

  async function wikiGetSummary(lang, title) {
    const url =
      `${wikiApiBase(lang)}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    return await getJson(url);
  }

  function extractImageFromSummary(summary) {
    // REST summary обычно даёт thumbnail и иногда originalimage
    const thumb = summary?.thumbnail?.source || '';
    const orig = summary?.originalimage?.source || '';
    return orig || thumb || '';
  }

  async function findWikiImageByName(name) {
    // 1) RU
    try {
      const titleRu = await wikiSearchFirstTitle('ru', name);
      if (titleRu) {
        const sumRu = await wikiGetSummary('ru', titleRu);
        const imgRu = extractImageFromSummary(sumRu);
        if (imgRu) return { img: imgRu, lang: 'ru', title: titleRu };
      }
    } catch (_) {}

    // 2) EN
    try {
      const titleEn = await wikiSearchFirstTitle('en', name);
      if (titleEn) {
        const sumEn = await wikiGetSummary('en', titleEn);
        const imgEn = extractImageFromSummary(sumEn);
        if (imgEn) return { img: imgEn, lang: 'en', title: titleEn };
      }
    } catch (_) {}

    return { img: '', lang: '', title: '' };
  }

  // -----------------------------
  // UI
  // -----------------------------
  GM_addStyle(`
    .abs-wiki-inline-wrap {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .abs-wiki-btn {
      font-size: 11.5px;
      line-height: 1;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid rgba(0,0,0,0.12);
      background: #fff;
      cursor: pointer;
      opacity: .95;
      transform: translateY(-1px);
    }
    .abs-wiki-btn:hover {
      opacity: 1;
      filter: brightness(0.98);
    }
    .abs-wiki-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      font-size: 11px;
      border-radius: 999px;
      background: rgba(0,0,0,0.08);
    }
    .abs-wiki-badge.ok {
      background: rgba(22, 163, 74, 0.15);
      color: #16a34a;
      border: 1px solid rgba(22, 163, 74, 0.35);
    }
    .abs-wiki-badge.no {
      background: rgba(220, 38, 38, 0.12);
      color: #dc2626;
      border: 1px solid rgba(220, 38, 38, 0.3);
    }
  `);

  function getAuthorH1() {
    if (!isAuthorPage()) return null;
    return document.querySelector('h1.text-2xl');
  }

  function getAuthorName() {
    const h1 = getAuthorH1();
    return h1 ? h1.textContent.trim() : '';
  }

  function ensureWrapped(h1) {
    if (h1.parentElement && h1.parentElement.classList.contains('abs-wiki-inline-wrap')) {
      return h1.parentElement;
    }

    const wrap = document.createElement('span');
    wrap.className = 'abs-wiki-inline-wrap';

    h1.parentNode.insertBefore(wrap, h1);
    wrap.appendChild(h1);

    return wrap;
  }

  function ensureBadge(wrap) {
    let badge = wrap.querySelector('.abs-wiki-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'abs-wiki-badge';
      badge.textContent = 'Wikipedia: готово';
      wrap.appendChild(badge);
    }
    return badge;
  }

  // -----------------------------
  // Inject button
  // -----------------------------
  function inject() {
    if (!isAuthorPage()) return;

    const h1 = getAuthorH1();
    if (!h1) return;

    if (h1.dataset.absWikiInjected === '1') return;
    h1.dataset.absWikiInjected = '1';

    const name = getAuthorName();
    if (!name) return;

    const wrap = ensureWrapped(h1);
    const badge = ensureBadge(wrap);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'abs-wiki-btn';
    btn.textContent = 'Wikipedia: фото в ABS';

    btn.addEventListener('click', async () => {
      const baseUrl = getBaseUrl();
      const token = getToken();

      if (!baseUrl || !token) {
        badge.textContent = 'Нет настроек ABS';
        badge.classList.remove('ok');
        badge.classList.add('no');
        return;
      }

      const authorId = getAuthorIdFromPath();
      const currentName = getAuthorName() || name;

      badge.textContent = 'Ищу в Wikipedia...';
      badge.classList.remove('ok', 'no');

      let found;
      try {
        found = await findWikiImageByName(currentName);
      } catch (e) {
        badge.textContent = 'Ошибка Wikipedia';
        badge.classList.add('no');
        return;
      }

      if (!found.img) {
        badge.textContent = 'Фото не найдено';
        badge.classList.add('no');
        return;
      }

      badge.textContent = `Нашёл фото (${found.lang})...`;

      const res = await trySetAuthorImage(authorId, found.img);

      if (res.ok) {
        badge.textContent = `Фото обновлено (${found.lang})`;
        badge.classList.remove('no');
        badge.classList.add('ok');
      } else {
        badge.textContent = 'Не удалось обновить фото';
        badge.classList.remove('ok');
        badge.classList.add('no');
      }
    });

    wrap.appendChild(btn);
  }

  // -----------------------------
  // SPA support
  // -----------------------------
  function patchHistory() {
    const _push = history.pushState;
    const _replace = history.replaceState;

    history.pushState = function () {
      const ret = _push.apply(this, arguments);
      window.dispatchEvent(new Event('abs:routechange'));
      return ret;
    };

    history.replaceState = function () {
      const ret = _replace.apply(this, arguments);
      window.dispatchEvent(new Event('abs:routechange'));
      return ret;
    };

    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('abs:routechange'));
    });
  }

  function init() {
    patchHistory();

    window.addEventListener('abs:routechange', () => {
      inject();
    });

    const obs = new MutationObserver(() => {
      inject();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    inject();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
