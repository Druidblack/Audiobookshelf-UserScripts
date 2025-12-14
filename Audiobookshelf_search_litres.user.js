// ==UserScript==
// @name         Audiobookshelf Author → LitRes Button
// @namespace    https://github.com/Druidblack/Audiobookshelf-UserScripts
// @version      0.3.1
// @description  Adds a button next to author name on Audiobookshelf author pages that opens the direct LitRes author page
// @author       Druidblack
//
// @match        http://192.168.1.161:16378/*
//
// @grant        GM_addStyle
//
// @downloadURL  https://github.com/Druidblack/Audiobookshelf-UserScripts/raw/main/Audiobookshelf_search_litres.user.js
// @updateURL    https://github.com/Druidblack/Audiobookshelf-UserScripts/raw/main/Audiobookshelf_search_litres.user.js
// ==/UserScript==

(function () {
  'use strict';

  // -----------------------------
  // Route guard
  // -----------------------------
  const AUTHOR_UUID_RE =
    /^\/audiobookshelf\/author\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

  function isAuthorPage() {
    return AUTHOR_UUID_RE.test(location.pathname);
  }

  // -----------------------------
  // Styles
  // -----------------------------
  GM_addStyle(`
    .abs-lr-inline-wrap {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .abs-lr-btn {
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
    .abs-lr-btn:hover {
      opacity: 1;
      filter: brightness(0.98);
    }
  `);

  // -----------------------------
  // DOM helpers
  // -----------------------------
  function getAuthorH1() {
    if (!isAuthorPage()) return null;
    return document.querySelector('h1.text-2xl');
  }

  function getAuthorName() {
    const h1 = getAuthorH1();
    return h1 ? h1.textContent.trim() : '';
  }

  function ensureWrapped(h1) {
    if (h1.parentElement && h1.parentElement.classList.contains('abs-lr-inline-wrap')) {
      return h1.parentElement;
    }

    const wrap = document.createElement('span');
    wrap.className = 'abs-lr-inline-wrap';

    h1.parentNode.insertBefore(wrap, h1);
    wrap.appendChild(h1);

    return wrap;
  }

  // -----------------------------
  // RU -> LAT translit for LitRes-like slug
  // -----------------------------
  const RU_MAP = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
    'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
    'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch',
    'ы':'y','э':'e','ю':'yu','я':'ya',
    'ь':'','ъ':''
  };

  function translitRuToLat(str) {
    const s = (str || '').toLowerCase();
    let out = '';
    for (const ch of s) {
      out += Object.prototype.hasOwnProperty.call(RU_MAP, ch) ? RU_MAP[ch] : ch;
    }
    return out;
  }

  function slugifyName(name) {
    let s = translitRuToLat(name);
    s = s.replace(/[^a-z0-9\s-]/g, ' ');
    s = s.trim().replace(/\s+/g, '-');
    s = s.replace(/-+/g, '-');
    return s;
  }

  function buildLitresAuthorUrl(name) {
    const slug = slugifyName(name);
    if (!slug) return '';
    return `https://www.litres.ru/author/${slug}/`;
  }

  // -----------------------------
  // Inject
  // -----------------------------
  function injectButton() {
    if (!isAuthorPage()) return;

    const h1 = getAuthorH1();
    if (!h1) return;

    // предотвращаем дубли
    if (h1.dataset.absLitresInjected === '1') return;
    h1.dataset.absLitresInjected = '1';

    const name = getAuthorName();
    if (!name) return;

    const wrap = ensureWrapped(h1);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'abs-lr-btn';
    btn.textContent = 'Открыть автора в LitRes';

    btn.addEventListener('click', () => {
      const currentName = getAuthorName() || name;
      const url = buildLitresAuthorUrl(currentName);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });

    wrap.appendChild(btn);
  }

  // -----------------------------
  // SPA route change hooks
  // -----------------------------
  function onRouteChange() {
    // Сбрасываем маркер у старых H1, если они были пересозданы
    // (не обязательно, но приятно для стабильности)
    injectButton();
  }

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

  // -----------------------------
  // Init
  // -----------------------------
  function init() {
    patchHistory();

    window.addEventListener('abs:routechange', onRouteChange);

    // На случай, если ABS обновляет DOM без history событий
    const obs = new MutationObserver(() => {
      // НО: injectButton сам проверит isAuthorPage()
      injectButton();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // Первый запуск
    injectButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
