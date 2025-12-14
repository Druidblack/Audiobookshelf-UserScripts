// ==UserScript==
// @name         LitRes → Audiobookshelf Author Photo + Description Linker
// @namespace    https://github.com/Druidblack/Audiobookshelf-UserScripts
// @version      0.4.0
// @description  Импорт описания и фотографии автора книги.
// @author       Druidblack
// @match        https://www.litres.ru/author/*
// @match        https://litres.ru/author/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      *
//
// @downloadURL  https://github.com/Druidblack/Audiobookshelf-UserScripts/raw/main/Audiobookshelf_litres_import.user.js
// @updateURL    https://github.com/Druidblack/Audiobookshelf-UserScripts/raw/main/Audiobookshelf_litres_import.user.js
// ==/UserScript==

(function () {
  'use strict';

  // -----------------------------
  // Settings
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
    return normalizeBaseUrl(gmGet(CFG.baseUrl, ''));
  }

  function getToken() {
    return gmGet(CFG.token, '');
  }

  GM_registerMenuCommand('LitRes→ABS: Settings', () => {
    const base = prompt('Audiobookshelf base URL (например http://192.168.1.161:16378)', getBaseUrl());
    if (base !== null) GM_setValue(CFG.baseUrl, normalizeBaseUrl(base));

    const tok = prompt('Audiobookshelf API token (Bearer)', getToken());
    if (tok !== null) GM_setValue(CFG.token, tok.trim());

    alert('Сохранено. Обнови страницу LitRes автора.');
  });

  function authHeaders() {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
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

  async function getJson(url) {
    const res = await gmRequest({ method: 'GET', url, headers: authHeaders(), responseType: 'json' });
    if (res.status >= 200 && res.status < 300) return res.response;
    throw new Error(`GET ${url} failed: ${res.status}`);
  }

  async function getText(url) {
    const res = await gmRequest({ method: 'GET', url, headers: {}, responseType: 'text' });
    if (res.status >= 200 && res.status < 300) return res.responseText;
    throw new Error(`GET ${url} failed: ${res.status}`);
  }

  async function postJson(url, body) {
    const res = await gmRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      data: JSON.stringify(body),
      responseType: 'json'
    });
    return res;
  }

  async function patchJson(url, body) {
    const res = await gmRequest({
      method: 'PATCH',
      url,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      data: JSON.stringify(body),
      responseType: 'json'
    });
    return res;
  }

  // -----------------------------
  // Name normalization / matching
  // -----------------------------
  function normName(s) {
    return (s || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[.,/#!$%^&*;:{}=\-_`~()'"“”«»]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isSameName(a, b) {
    const na = normName(a);
    const nb = normName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;

    const pa = na.split(' ');
    const pb = nb.split(' ');
    if (pa.length === 2 && pb.length === 2) {
      if (pa[0] === pb[1] && pa[1] === pb[0]) return true;
    }
    return false;
  }

  function looseIncludes(a, b) {
    const na = normName(a);
    const nb = normName(b);
    if (!na || !nb) return false;
    return na.includes(nb) || nb.includes(na);
  }

  // -----------------------------
  // ABS: libraries → authors
  // -----------------------------
  function extractList(payload, key) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload[key])) return payload[key];
    return [];
  }

  async function absGetLibraries(baseUrl) {
    const data = await getJson(`${baseUrl}/api/libraries`);
    return extractList(data, 'libraries');
  }

  async function absGetLibraryAuthors(baseUrl, libId) {
    const data = await getJson(`${baseUrl}/api/libraries/${encodeURIComponent(libId)}/authors`);
    return extractList(data, 'authors');
  }

  let cachedAuthors = null;
  async function absGetAllAuthorsAcrossLibraries(baseUrl) {
    if (cachedAuthors) return cachedAuthors;

    const libs = await absGetLibraries(baseUrl);
    const all = [];

    for (const lib of libs) {
      if (!lib?.id) continue;
      try {
        const authors = await absGetLibraryAuthors(baseUrl, lib.id);
        all.push(...authors);
      } catch (_) {}
    }

    const map = new Map();
    for (const a of all) {
      if (a?.id && !map.has(a.id)) map.set(a.id, a);
    }

    cachedAuthors = Array.from(map.values());
    return cachedAuthors;
  }

  async function findAuthorInAbs(nameCandidates) {
    const baseUrl = getBaseUrl();
    if (!baseUrl) throw new Error('ABS baseUrl not set');

    const all = await absGetAllAuthorsAcrossLibraries(baseUrl);
    if (!all.length) return null;

    for (const name of nameCandidates) {
      const exact = all.find(a => isSameName(a.name, name));
      if (exact) return exact;
    }

    for (const name of nameCandidates) {
      const partial = all.find(a => looseIncludes(a.name, name));
      if (partial) return partial;
    }

    return null;
  }

  // -----------------------------
  // ABS: apply image + description
  // -----------------------------
  async function trySetAuthorImage(authorId, imageUrl) {
    const baseUrl = getBaseUrl();

    // 1) POST /api/authors/{id}/image { url }
    try {
      const res = await postJson(`${baseUrl}/api/authors/${encodeURIComponent(authorId)}/image`, { url: imageUrl });
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, method: 'POST /authors/{id}/image {url}' };
      }
    } catch (_) {}

    // 2) PATCH /api/authors/{id} { imagePath: url }
    try {
      const res = await patchJson(`${baseUrl}/api/authors/${encodeURIComponent(authorId)}`, { imagePath: imageUrl });
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, method: 'PATCH imagePath=url' };
      }
    } catch (_) {}

    return { ok: false, method: 'none' };
  }

  async function absSetAuthorDescription(authorId, description) {
    const baseUrl = getBaseUrl();
    if (!description) return { ok: false };

    try {
      const res = await patchJson(`${baseUrl}/api/authors/${encodeURIComponent(authorId)}`, { description });
      if (res.status >= 200 && res.status < 300) {
        return { ok: true };
      }
    } catch (_) {}

    return { ok: false };
  }

  // -----------------------------
  // LitRes DOM extraction
  // -----------------------------
  function getLitresAuthorNameEl() {
    return document.querySelector('h1[itemprop="name"]') || document.querySelector('h1');
  }

  function getLitresAuthorName() {
    const el = getLitresAuthorNameEl();
    return el ? el.textContent.trim() : '';
  }

  function getLitresAvatarUrl() {
    const img =
      document.querySelector('div[data-testid="author__avatarPerson"] img') ||
      document.querySelector('img[src*="cdn.litres.ru/pub/authors"]');
    return img?.getAttribute('src') || '';
  }

  function getSlugCandidateFromUrl() {
    const parts = location.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('author');
    if (idx === -1 || !parts[idx + 1]) return '';
    const slug = decodeURIComponent(parts[idx + 1]).replace(/-/g, ' ').trim();
    if (!slug) return '';
    return slug.split(' ').map(w => w ? (w[0].toUpperCase() + w.slice(1)) : w).join(' ');
  }

  function getOgTitleCandidate() {
    const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
    if (!og) return '';
    return og.split('—')[0].trim();
  }

  function getLitresAuthorNameCandidates() {
    const set = new Set();
    const h1 = getLitresAuthorName();
    const og = getOgTitleCandidate();
    const slug = getSlugCandidateFromUrl();

    if (h1) set.add(h1);
    if (og) set.add(og);
    if (slug) set.add(slug);

    return Array.from(set).filter(Boolean);
  }

  function getShortDescriptionFromCurrentPage() {
    const root = document.querySelector('[data-testid="author__personDescription"]');
    if (!root) return '';

    // Клонируем, чтобы убрать "читать полностью"
    const clone = root.cloneNode(true);
    const a = clone.querySelector('a[href*="/about/"]');
    if (a) a.remove();

    const text = (clone.innerText || '').trim();
    return normalizeText(text);
  }

  function findAboutLinkOnCurrentPage() {
    const block = document.querySelector('[data-testid="author__personDescription"]');
    const a = block?.querySelector('a[href*="/about/"]');
    const href = a?.getAttribute('href') || '';
    if (!href) return '';

    try {
      return new URL(href, location.origin).href;
    } catch (_) {
      return '';
    }
  }

  function buildAboutUrlFromSlug() {
    const parts = location.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('author');
    if (idx === -1 || !parts[idx + 1]) return '';
    const slug = parts[idx + 1];
    return `${location.origin}/author/${slug}/about/`;
  }

  function normalizeText(t) {
    return (t || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function extractFullDescriptionFromAboutDoc(doc) {
    const container =
      doc.querySelector('div[data-analytics-scroll-block="about_author"]') ||
      doc.querySelector('[data-analytics-scroll-block="about_author"]');

    if (!container) return '';

    // innerText сохранит разумные переводы строк
    const text = normalizeText(container.innerText || '');
    return text;
  }

  async function fetchFullDescriptionFromAboutPage() {
    const direct = findAboutLinkOnCurrentPage();
    const fallback = buildAboutUrlFromSlug();
    const candidates = [direct, fallback].filter(Boolean);

    for (const url of candidates) {
      try {
        const html = await getText(url);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const desc = extractFullDescriptionFromAboutDoc(doc);
        if (desc && desc.length > 40) return desc;
      } catch (_) {}
    }

    return '';
  }

  // -----------------------------
  // UI
  // -----------------------------
  GM_addStyle(`
    .lr-abs-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 10px;
      padding: 2px 8px;
      font-size: 11px;
      border-radius: 999px;
      vertical-align: middle;
      background: rgba(0,0,0,0.08);
    }
    .lr-abs-badge.ok {
      background: rgba(22, 163, 74, 0.15);
      color: #16a34a;
      border: 1px solid rgba(22, 163, 74, 0.35);
    }
    .lr-abs-badge.no {
      background: rgba(220, 38, 38, 0.12);
      color: #dc2626;
      border: 1px solid rgba(220, 38, 38, 0.3);
    }
    .lr-abs-btn {
      margin-left: 10px;
      padding: 4px 9px;
      font-size: 11.5px;
      border-radius: 8px;
      border: 1px solid rgba(0,0,0,0.12);
      background: #fff;
      cursor: pointer;
    }
    .lr-abs-btn:hover { filter: brightness(0.98); }
    .lr-abs-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .lr-abs-name-found {
      outline: 2px solid rgba(22, 163, 74, 0.35);
      border-radius: 8px;
      padding: 2px 6px;
      background: rgba(22, 163, 74, 0.08);
    }
    .lr-abs-name-notfound {
      outline: 2px solid rgba(220, 38, 38, 0.25);
      border-radius: 8px;
      padding: 2px 6px;
      background: rgba(220, 38, 38, 0.06);
    }
  `);

  function ensureBadge(h1) {
    let badge = h1.querySelector('.lr-abs-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'lr-abs-badge';
      badge.textContent = 'ABS: проверяю...';
      h1.appendChild(badge);
    }
    return badge;
  }

  function ensureButton(h1) {
    let btn = h1.querySelector('.lr-abs-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lr-abs-btn';
      btn.textContent = 'Применить фото и описание в ABS';
      btn.disabled = true;
      h1.appendChild(btn);
    } else {
      btn.textContent = 'Применить фото и описание в ABS';
    }
    return btn;
  }

  function setFoundUI(h1, badge) {
    h1.classList.remove('lr-abs-name-notfound');
    h1.classList.add('lr-abs-name-found');
    badge.classList.remove('no');
    badge.classList.add('ok');
  }

  function setNotFoundUI(h1, badge) {
    h1.classList.remove('lr-abs-name-found');
    h1.classList.add('lr-abs-name-notfound');
    badge.classList.remove('ok');
    badge.classList.add('no');
  }

  // -----------------------------
  // Main
  // -----------------------------
  async function main() {
    const h1 = getLitresAuthorNameEl();
    if (!h1) return;

    const baseUrl = getBaseUrl();
    const token = getToken();

    const badge = ensureBadge(h1);
    const btn = ensureButton(h1);

    if (!baseUrl || !token) {
      badge.textContent = 'ABS: нет настроек';
      badge.classList.add('no');
      btn.disabled = true;
      return;
    }

    const nameCandidates = getLitresAuthorNameCandidates();
    if (!nameCandidates.length) return;

    badge.textContent = 'ABS: поиск...';

    let author = null;
    try {
      author = await findAuthorInAbs(nameCandidates);
    } catch (e) {
      console.warn('[LitRes→ABS] search error', e);
      badge.textContent = 'ABS: ошибка поиска';
      badge.classList.add('no');
      btn.disabled = true;
      return;
    }

    if (!author?.id) {
      setNotFoundUI(h1, badge);
      badge.textContent = 'ABS: не найден';
      btn.disabled = true;
      return;
    }

    // Found
    setFoundUI(h1, badge);
    badge.textContent = 'ABS: найден';
    btn.disabled = false;

    btn.onclick = async () => {
      btn.disabled = true;

      const avatarUrl = getLitresAvatarUrl();

      badge.textContent = 'ABS: получаю полное описание...';

      // 1) Пытаемся взять полное описание со страницы /about/
      let description = '';
      try {
        description = await fetchFullDescriptionFromAboutPage();
      } catch (_) {}

      // 2) Фоллбек на короткое описание
      if (!description) {
        description = getShortDescriptionFromCurrentPage();
      }

      // 3) Отправляем описание
      if (description) {
        badge.textContent = 'ABS: обновляю описание...';
        await absSetAuthorDescription(author.id, description);
      } else {
        // если описания нет — просто сообщим дальше
      }

      // 4) Отправляем фото
      if (!avatarUrl) {
        badge.textContent = description
          ? 'ABS: описание обновлено, фото не найдено на LitRes'
          : 'ABS: нет фото и описания на LitRes';
        btn.disabled = false;
        return;
      }

      badge.textContent = 'ABS: обновляю фото...';

      const imgRes = await trySetAuthorImage(author.id, avatarUrl);

      if (imgRes.ok && description) {
        badge.textContent = 'ABS: фото и описание обновлены';
      } else if (imgRes.ok) {
        badge.textContent = 'ABS: фото обновлено';
      } else if (description) {
        badge.textContent = 'ABS: описание обновлено, фото не удалось';
      } else {
        badge.textContent = 'ABS: не удалось обновить данные';
      }

      btn.disabled = false;
    };
  }

  // SPA/динамический DOM
  function initWithObserver() {
    main();

    const obs = new MutationObserver(() => {
      const h1 = getLitresAuthorNameEl();
      if (h1 && !h1.dataset.lrAbsInjected) {
        h1.dataset.lrAbsInjected = '1';
        main();
      }
    });

    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWithObserver);
  } else {
    initWithObserver();
  }

})();
