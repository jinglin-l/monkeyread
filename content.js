/*
 * monkeyread: content script
 * ===========================
 *
 * Press "m" on any page and its main text becomes a monkeytype-style typing
 * test. Press Escape to leave.
 *
 * The one hard rule is that the page's layout must not change. That rules out
 * monkeytype's own approach of wrapping every letter in an element. Instead:
 *
 *   1. TEXT MODEL: we find the article-like part of the page, walk its text
 *      nodes and build a flat array of "chars". Each char points back to a
 *      (textNode, offset) pair instead of being copied into new DOM.
 *
 *   2. COLOURING: the CSS Custom Highlight API paints Ranges over those text
 *      nodes (see content.css). The DOM tree is never edited.
 *
 *   3. CARET: one absolutely positioned element in a closed shadow root,
 *      hung off <html>. It's moved with a CSS transform so it never takes
 *      part in layout. Its motion copies what monkeytype.com does (measured
 *      in the live site, see CARET_* constants below).
 *
 *   4. HUD: a fixed-position panel in the same shadow root showing live WPM
 *      (words per minute), accuracy and time, plus your personal best and
 *      recent average from browser.storage.
 *
 * Test lifecycle: the timer starts on the first keystroke. If you go
 * IDLE_RESET_MS without typing, the test ends: the result is saved (if long
 * enough to mean anything), colouring is cleared and the caret waits at the
 * start of the current word for the next test.
 */
(() => {
  'use strict';

  // Content scripts can be injected twice (e.g. extension reload during
  // development); a second copy would double-handle every key.
  if (window.__monkeyreadLoaded) return;
  window.__monkeyreadLoaded = true;

  /* ------------------------------------------------------------------ *
   * Tunables
   * ------------------------------------------------------------------ */

  // Caret motion, profiled from monkeytype.com (smooth caret, default
  // settings). Monkeytype tweens the caret's left/top in JS on every
  // keypress. Sampling style.left once per frame after a single key showed
  // progress of 0.24, 0.43, 0.65, 0.83, 0.97, 1.0 at ~16.7ms intervals,
  // which fits an ease-out-quad curve over ~120ms. We get the same motion
  // from a CSS transition on transform, which also runs on the compositor,
  // and retargets from wherever the caret is mid-flight when you type fast,
  // just like monkeytype's tween does.
  const CARET_MOVE_MS = 120;
  const CARET_EASE = 'cubic-bezier(0.5, 1, 0.89, 1)'; // easeOutQuad
  const CARET_COLOR = '#e2b714'; // serika dark caret colour
  const ERROR_COLOR = '#ca4754';
  // Monkeytype caret: width 0.1em, rounded ends. Height comes from the glyph
  // box of the letter we're sitting on, which is ~1.2em like theirs.
  const CARET_WIDTH_EM = 0.1;
  // Pre-test blink: monkeytype's "caretFlashSmooth" keyframes are
  // opacity 0 -> 1 -> 0 over 1s with `ease`. While a test is running the
  // caret is solid, which is also what monkeytype does.
  const BLINK_MS = 1000;

  const IDLE_RESET_MS = 15000;
  // A result shorter than this is noise (one stray keypress would otherwise
  // produce a 200 WPM "personal best").
  const MIN_RESULT_MS = 5000;
  const MIN_RESULT_CHARS = 15;
  // Live WPM over the first second swings wildly, so the HUD shows a dash.
  const LIVE_WPM_GRACE_MS = 1000;
  const HISTORY_KEY = 'monkeyread.results';
  const HISTORY_CAP = 200;

  const HL_NAMES = {
    untyped: 'monkeyread-untyped',
    error: 'monkeyread-error',
    errorSpace: 'monkeyread-error-space',
    missed: 'monkeyread-missed',
  };

  // Char status values, kept in a Uint8Array parallel to `chars`.
  const UNTYPED = 0, CORRECT = 1, WRONG = 2, MISSED = 3;

  // Elements whose text we never ask the user to type: code and UI chrome,
  // invisible stuff, and footnote markers like Wikipedia's "[12]".
  const SKIP_SEL = [
    'script', 'style', 'noscript', 'template', 'svg', 'math', 'nav', 'aside',
    'footer', 'form', 'button', 'select', 'textarea', 'input', 'label',
    '[contenteditable=""]', '[contenteditable="true"]', '[aria-hidden="true"]',
    '[hidden]', 'sup',
  ].join(',');

  // "Blocks" are the units we read in document order. Between two blocks we
  // insert a virtual space so the end of a paragraph is typed like the end of
  // a word.
  const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,figcaption,td,th,pre';

  /* ------------------------------------------------------------------ *
   * Storage: browser.storage.local, with an in-memory fallback so the script
   * can also be injected into a plain page for testing.
   * ------------------------------------------------------------------ */
  const store = (() => {
    const api = globalThis.browser?.storage?.local;
    if (api) {
      return {
        get: (k) => api.get(k).then((o) => o[k]),
        set: (k, v) => api.set({ [k]: v }),
      };
    }
    const mem = {};
    return { get: async (k) => mem[k], set: async (k, v) => { mem[k] = v; } };
  })();

  /* ------------------------------------------------------------------ *
   * Highlight API access
   *
   * Firefox runs content scripts in a sandbox that sees the page through
   * "Xray" wrappers. The Highlight API is a plain WebIDL interface so it
   * should work directly, but maplike registries through Xrays have been
   * shaky historically, so we probe it and fall back to the page's own
   * objects via wrappedJSObject. Ranges are always made with
   * document.createRange(), so they belong to the page either way.
   * ------------------------------------------------------------------ */
  function getHighlightApi() {
    const worlds = [window];
    if (window.wrappedJSObject) worlds.push(window.wrappedJSObject);
    for (const w of worlds) {
      try {
        const registry = w.CSS && w.CSS.highlights;
        const H = w.Highlight;
        if (!registry || typeof H !== 'function') continue;
        const probe = new H();
        registry.set('monkeyread-probe', probe);
        const ok = registry.has('monkeyread-probe');
        registry.delete('monkeyread-probe');
        if (ok) return { registry, H };
      } catch (_) { /* try the next world */ }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Text model
   * ------------------------------------------------------------------ */

  // Map typographic characters to what a person can type on a US keyboard.
  // Without this, every curly apostrophe on a news site is a guaranteed miss.
  const CHAR_MAP = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
    '“': '"', '”': '"', '„': '"', '″': '"',
    '«': '"', '»': '"',
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
    '−': '-', '…': '.',
  };

  // Returns ' ' for any whitespace, a printable ASCII char for typeable text,
  // or '' for characters to drop from the test (emoji, CJK, zero-width
  // spaces, soft hyphens). Accents are stripped so "café" types as "cafe".
  function normalizeChar(ch) {
    if (/\s/.test(ch)) return ' ';
    if (CHAR_MAP[ch]) return CHAR_MAP[ch];
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return /^[\x21-\x7E]$/.test(base) ? base : '';
  }

  function isRendered(el) {
    if (!el || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  }

  // Pick the element that holds the article. A small take on Readability's
  // idea: substantial paragraphs vote for their parent (full weight) and
  // grandparent (half weight), and the winner is the content root. If it
  // sits inside an <article>/<main>, widen to that so the headline is
  // included too.
  function findContentRoot() {
    const scores = new Map();
    const vote = (el, n) => el && scores.set(el, (scores.get(el) || 0) + n);
    for (const p of document.querySelectorAll('p')) {
      if (p.closest(SKIP_SEL)) continue;
      const len = p.textContent.trim().length;
      if (len < 25) continue;
      vote(p.parentElement, len);
      vote(p.parentElement?.parentElement, len / 2);
    }
    let best = null, bestScore = 0;
    for (const [el, s] of scores) if (s > bestScore) { best = el; bestScore = s; }
    if (!best) return document.querySelector('article, main, [role="main"]') || document.body;
    return best.closest('article, main, [role="main"]') || best;
  }

  // Leaf blocks only: an <li> containing a <p> is represented by the <p>,
  // otherwise its text would be counted twice. Known trade-off: text that
  // sits directly in a block next to a nested block (e.g. an <li>'s label
  // before a sub-list) is skipped.
  function collectBlocks(root) {
    const blocks = [...root.querySelectorAll(BLOCK_SEL)].filter((el) =>
      !el.closest(SKIP_SEL) &&
      !el.querySelector(BLOCK_SEL) &&
      el.textContent.trim() &&
      isRendered(el));
    // Div-soup pages with no semantic blocks: treat the whole root as one.
    return blocks.length ? blocks : [root];
  }

  /*
   * Build the flat char array. Each entry:
   *   { node, off, len, exp, synthetic?, block }
   * `exp` is the expected keystroke. `len` is 2 for astral code points so
   * Ranges never split a surrogate pair. Whitespace runs collapse to one
   * space, matching how the browser renders them, and the space points at
   * the first whitespace char in the run. Between blocks there's no
   * whitespace node to point at, so a `synthetic` space is added; its caret
   * position is the right edge of the char before it.
   */
  function buildChars(blocks) {
    const chars = [];
    const blockStarts = [];
    blocks.forEach((block, bi) => {
      const startLen = chars.length;
      let pendingSpace = null;
      let sawText = false;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
          if (!isRendered(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.data;
        for (let off = 0; off < text.length;) {
          const cp = text.codePointAt(off);
          const len = cp > 0xFFFF ? 2 : 1;
          const exp = normalizeChar(String.fromCodePoint(cp));
          if (exp === ' ') {
            if (sawText && !pendingSpace) pendingSpace = { node, off, len, exp: ' ', block: bi };
          } else if (exp) {
            if (pendingSpace) { chars.push(pendingSpace); pendingSpace = null; }
            chars.push({ node, off, len, exp, block: bi });
            sawText = true;
          }
          off += len;
        }
      }
      // Trailing whitespace inside the block is dropped (it's often not
      // rendered, so has no rect); the synthetic separator replaces it.
      if (chars.length > startLen) {
        blockStarts.push(startLen);
        const last = chars[chars.length - 1];
        chars.push({ node: last.node, off: last.off, len: last.len, exp: ' ', synthetic: true, block: bi });
      }
    });
    if (chars.length && chars[chars.length - 1].synthetic) chars.pop();
    return { chars, blockStarts };
  }

  function charRange(c) {
    const r = document.createRange();
    r.setStart(c.node, c.off);
    r.setEnd(c.node, c.off + c.len);
    return r;
  }

  // First non-empty client rect of a char, or null. A char that wraps can
  // report several rects; the first is the one on the line where it starts.
  function glyphRect(c) {
    const rects = charRange(c).getClientRects();
    for (const r of rects) if (r.width > 0 || r.height > 0) return r;
    return null;
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const S = {
    active: false,
    hl: null,           // { registry, H }
    hls: null,          // our Highlight objects, keyed like HL_NAMES
    errorRanges: new Map(), // char index -> Range currently in an error highlight
    chars: [],
    blockStarts: [],
    nodeIndex: null,    // Map<TextNode, number[]> for click-to-place
    status: null,       // Uint8Array, one per char
    cursor: 0,
    testStart: 0,
    started: false,
    startTime: 0,
    lastKeyTime: 0,
    correctKeys: 0,
    wrongKeys: 0,
    idleTimer: 0,
    hudTimer: 0,
    history: [],
    lastResult: null,
    ended: false,       // reached the end of the text
    root: null,
    resizeObs: null,
  };

  /* ------------------------------------------------------------------ *
   * Overlay: caret + HUD
   *
   * Everything lives in a closed shadow root on a custom element appended to
   * <html> (not <body>, which sites often make position:relative or
   * transform). Only inline styles are used: a <style> element in the shadow
   * root could be blocked by a strict page CSP, while element.style and the
   * Web Animations API are not subject to CSP.
   * ------------------------------------------------------------------ */
  let host, caret, hud, blinkAnim = null;

  function buildOverlay() {
    host = document.createElement('monkeyread-overlay');
    // Zero-size, absolutely positioned at the document origin: it can't push
    // anything around, and its own rect gives us the coordinate origin for
    // the caret no matter how <html> is positioned.
    host.style.cssText = 'all:initial;display:block;position:absolute;left:0;top:0;' +
      'width:0;height:0;margin:0;padding:0;border:0;overflow:visible;' +
      'z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });

    caret = document.createElement('div');
    caret.style.cssText = `position:absolute;left:0;top:0;width:3px;height:1em;` +
      `background:${CARET_COLOR};border-radius:8px;will-change:transform;` +
      `transition:transform ${CARET_MOVE_MS}ms ${CARET_EASE},height ${CARET_MOVE_MS}ms ${CARET_EASE};`;
    shadow.appendChild(caret);

    hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;top:16px;right:16px;min-width:180px;' +
      'padding:10px 14px;border-radius:8px;background:rgba(50,52,55,0.94);' +
      'color:#d1d0c5;box-shadow:0 4px 18px rgba(0,0,0,0.25);' +
      "font:13px/1.4 'Roboto Mono','JetBrains Mono',ui-monospace,Menlo,monospace;" +
      'text-align:left;letter-spacing:0;';
    shadow.appendChild(hud);

    document.documentElement.appendChild(host);
  }

  function setBlink(on) {
    if (on && !blinkAnim) {
      // Per-keyframe easing reproduces CSS `animation-timing-function: ease`,
      // which applies to each keyframe interval, not the whole iteration.
      blinkAnim = caret.animate(
        [{ opacity: 0, easing: 'ease' }, { opacity: 1, easing: 'ease' }, { opacity: 0 }],
        { duration: BLINK_MS, iterations: Infinity });
    } else if (!on && blinkAnim) {
      blinkAnim.cancel();
      blinkAnim = null;
    }
  }

  // Viewport position where the caret should sit for char index i: the left
  // edge of that char, or the right edge of the previous one when the char
  // has no box (virtual block separators, whitespace collapsed at a line end,
  // and the end of the text).
  function caretPoint(i) {
    const { chars } = S;
    if (i < chars.length && !chars[i].synthetic) {
      const r = glyphRect(chars[i]);
      if (r) return { x: r.left, y: r.top, h: r.height, node: chars[i].node };
    }
    for (let k = Math.min(i, chars.length) - 1; k >= 0; k--) {
      if (chars[k].synthetic) continue;
      const r = glyphRect(chars[k]);
      if (r) return { x: r.right, y: r.top, h: r.height, node: chars[k].node };
    }
    return null;
  }

  function placeCaret({ instant = false, scroll = true } = {}) {
    const p = caretPoint(S.cursor);
    if (!p) return;
    const fontPx = parseFloat(getComputedStyle(p.node.parentElement).fontSize) || 16;
    const w = Math.max(2, fontPx * CARET_WIDTH_EM);
    const origin = host.getBoundingClientRect();
    // Centre the bar on the letter boundary, as monkeytype does.
    const x = p.x - origin.left - w / 2;
    const y = p.y - origin.top;
    if (instant) caret.style.transition = 'none';
    caret.style.width = `${w}px`;
    caret.style.height = `${p.h}px`;
    caret.style.transform = `translate(${x}px, ${y}px)`;
    if (instant) {
      // Force a style flush so the jump is committed before the transition
      // is restored; otherwise the browser coalesces both and animates.
      void caret.offsetWidth;
      caret.style.transition = `transform ${CARET_MOVE_MS}ms ${CARET_EASE},height ${CARET_MOVE_MS}ms ${CARET_EASE}`;
    }
    if (scroll) keepInView(p);
  }

  // Monkeytype keeps the active line in a fixed band. We do the same with
  // whichever element actually scrolls the text: once the caret leaves the
  // middle band of that scroller, scroll it back to ~40% height.
  function keepInView(p) {
    let scroller = p.node.parentElement;
    while (scroller && scroller !== document.body && scroller !== document.documentElement) {
      const cs = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    const inner = scroller && scroller !== document.body && scroller !== document.documentElement;
    const top = inner ? scroller.getBoundingClientRect().top : 0;
    const height = inner ? scroller.clientHeight : window.innerHeight;
    const rel = p.y - top;
    if (rel < height * 0.15 || rel + p.h > height * 0.75) {
      const delta = rel - height * 0.4;
      (inner ? scroller : window).scrollBy({ top: delta, behavior: 'smooth' });
    }
  }

  // Layout can shift under us (images loading, window resize, an inner
  // scroller moving). Re-measure once per frame at most and jump the caret
  // without animation, since it's the page that moved, not the caret.
  let resyncQueued = false;
  function resync() {
    if (resyncQueued || !S.active) return;
    resyncQueued = true;
    requestAnimationFrame(() => {
      resyncQueued = false;
      if (S.active) placeCaret({ instant: true, scroll: false });
    });
  }
  // Scroll events don't bubble, so listen in the capture phase to see inner
  // scrollers. Plain document scrolling needs nothing: the caret is in
  // document coordinates and scrolls along with the text.
  const onScroll = (e) => { if (e.target !== document) resync(); };

  /* ------------------------------------------------------------------ *
   * Highlights
   * ------------------------------------------------------------------ */
  function setupHighlights() {
    S.hl = S.hl || getHighlightApi();
    if (!S.hl) return;
    S.hls = {};
    for (const [key, name] of Object.entries(HL_NAMES)) {
      const h = new S.hl.H();
      S.hls[key] = h;
      S.hl.registry.set(name, h);
    }
  }

  function teardownHighlights() {
    if (!S.hl || !S.hls) return;
    for (const name of Object.values(HL_NAMES)) S.hl.registry.delete(name);
    S.hls = null;
    S.errorRanges.clear();
  }

  // The untyped highlight is one Range from the caret to the end of the text,
  // rebuilt on every move (cheaper and simpler than per-letter ranges).
  function refreshUntyped() {
    if (!S.hls) return;
    S.hls.untyped.clear();
    const { chars } = S;
    let i = S.cursor;
    while (i < chars.length && chars[i].synthetic) i++;
    if (i >= chars.length) return;
    const last = chars[chars.length - 1];
    const r = document.createRange();
    r.setStart(chars[i].node, chars[i].off);
    r.setEnd(last.node, last.off + last.len);
    S.hls.untyped.add(r);
  }

  function setStatus(i, st) {
    const prev = S.status[i];
    if (prev === st) return;
    S.status[i] = st;
    if (!S.hls) return;
    const old = S.errorRanges.get(i);
    if (old) {
      S.hls.error.delete(old);
      S.hls.errorSpace.delete(old);
      S.hls.missed.delete(old);
      S.errorRanges.delete(i);
    }
    const c = S.chars[i];
    if (st === UNTYPED || st === CORRECT || c.synthetic) return;
    const r = charRange(c);
    const target = st === MISSED ? S.hls.missed : (c.exp === ' ' ? S.hls.errorSpace : S.hls.error);
    target.add(r);
    S.errorRanges.set(i, r);
  }

  function clearStatuses(from, to) {
    for (let i = from; i < to; i++) setStatus(i, UNTYPED);
  }

  /* ------------------------------------------------------------------ *
   * HUD
   * ------------------------------------------------------------------ */
  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function benchmarks() {
    const h = S.history;
    if (!h.length) return null;
    const pb = Math.max(...h.map((r) => r.wpm));
    const recent = h.slice(-10);
    const avg = recent.reduce((a, r) => a + r.wpm, 0) / recent.length;
    return { pb, avg, n: recent.length };
  }

  // The HUD is rebuilt with textContent on plain nodes; never innerHTML,
  // since nothing here should ever be parsed as markup.
  function renderHud(main, sub, highlightSub = false) {
    hud.replaceChildren();
    const line1 = document.createElement('div');
    line1.style.cssText = 'display:flex;gap:14px;align-items:baseline;white-space:nowrap;';
    for (const [value, unit, color] of main) {
      const cell = document.createElement('span');
      const v = document.createElement('span');
      v.textContent = value;
      v.style.cssText = `font-size:22px;color:${color || CARET_COLOR};`;
      const u = document.createElement('span');
      u.textContent = unit ? ` ${unit}` : '';
      u.style.cssText = 'color:#646669;font-size:12px;';
      cell.append(v, u);
      line1.appendChild(cell);
    }
    const line2 = document.createElement('div');
    line2.textContent = sub;
    line2.style.cssText = `margin-top:4px;font-size:12px;color:${highlightSub ? CARET_COLOR : '#646669'};white-space:nowrap;`;
    hud.append(line1, line2);
  }

  function benchLine() {
    const b = benchmarks();
    return b ? `pb ${Math.round(b.pb)} · avg ${Math.round(b.avg)} (last ${b.n})` : 'no results yet';
  }

  function updateHud() {
    if (!hud) return;
    if (S.started) {
      const now = performance.now();
      const st = computeStats(now);
      const live = now - S.startTime >= LIVE_WPM_GRACE_MS;
      const b = benchmarks();
      // Colour the WPM against your personal best: that's the "benchmark".
      const wpmColor = !live || !b ? CARET_COLOR : st.wpm >= b.pb ? '#7ec16e' : st.wpm >= b.avg ? CARET_COLOR : '#d1d0c5';
      renderHud([
        [live ? String(Math.round(st.wpm)) : '-', 'wpm', wpmColor],
        [`${Math.round(st.acc)}%`, 'acc'],
        [fmtTime(now - S.startTime), ''],
      ], benchLine());
      return;
    }
    if (S.lastResult) {
      const r = S.lastResult;
      renderHud([
        [String(Math.round(r.wpm)), 'wpm'],
        [`${Math.round(r.acc)}%`, 'acc'],
        [fmtTime(r.ms), ''],
      ], r.pb ? 'new personal best!' : r.saved ? benchLine() : 'too short to save · ' + benchLine(), r.pb);
      return;
    }
    renderHud([['ready', '']], S.ended ? 'end of text · esc to exit' : `start typing · esc to exit · ${benchLine()}`);
  }

  /* ------------------------------------------------------------------ *
   * Stats
   *
   * WPM is monkeytype's definition: correctly typed characters (spaces
   * included) / 5, per minute. Raw WPM counts every typed character.
   * Accuracy is per keystroke, so a fixed typo still costs you.
   * ------------------------------------------------------------------ */
  function computeStats(endTime) {
    const ms = Math.max(1, endTime - S.startTime);
    let correct = 0, typed = 0;
    for (let i = S.testStart; i < S.cursor; i++) {
      typed++;
      if (S.status[i] === CORRECT) correct++;
    }
    const minutes = ms / 60000;
    const keys = S.correctKeys + S.wrongKeys;
    return {
      ms,
      chars: typed,
      wpm: correct / 5 / minutes,
      raw: typed / 5 / minutes,
      acc: keys ? (S.correctKeys / keys) * 100 : 100,
    };
  }

  /* ------------------------------------------------------------------ *
   * Test lifecycle
   * ------------------------------------------------------------------ */
  function wordStart(i) {
    while (i > 0 && S.chars[i - 1].exp !== ' ') i--;
    return i;
  }

  // Index of the first block currently on screen, so the test starts where
  // you're reading rather than at the top of a long article. The 60px
  // margin skips a block that is mostly hidden under a sticky header.
  function firstVisibleIndex() {
    for (const start of S.blockStarts) {
      const r = glyphRect(S.chars[start]);
      if (r && r.bottom > 60 && r.top < window.innerHeight) return start;
    }
    return S.blockStarts[0] || 0;
  }

  function resetAt(i) {
    clearStatuses(S.testStart, Math.max(S.cursor, S.testStart));
    S.testStart = S.cursor = i;
    S.correctKeys = S.wrongKeys = 0;
    refreshUntyped();
    placeCaret();
    setBlink(true);
    updateHud();
  }

  function startTest() {
    // If you scrolled away from an idle caret, start where you're looking.
    const p = caretPoint(S.cursor);
    if (!p || p.y + p.h < 0 || p.y > window.innerHeight) {
      resetAt(firstVisibleIndex());
    }
    S.started = true;
    S.lastResult = null;
    S.startTime = performance.now();
    S.correctKeys = S.wrongKeys = 0;
    setBlink(false);
    S.hudTimer = setInterval(updateHud, 250);
  }

  // Ends the running test, saves the result, and (unless we hit the end of
  // the text) clears the colouring so the next test starts fresh from the
  // start of the current word.
  function endTest(reason) {
    if (!S.started) return;
    clearTimeout(S.idleTimer);
    clearInterval(S.hudTimer);
    // Time stops at the last keystroke: the idle wait isn't typing time.
    const st = computeStats(S.lastKeyTime);
    S.started = false;
    const saved = st.ms >= MIN_RESULT_MS && st.chars >= MIN_RESULT_CHARS;
    const prevPb = benchmarks()?.pb ?? 0;
    S.lastResult = { ...st, saved, pb: saved && st.wpm > prevPb };
    if (saved) {
      S.history.push({
        wpm: +st.wpm.toFixed(2), raw: +st.raw.toFixed(2), acc: +st.acc.toFixed(2),
        ms: Math.round(st.ms), chars: st.chars, at: Date.now(), host: location.hostname,
      });
      S.history = S.history.slice(-HISTORY_CAP);
      store.set(HISTORY_KEY, S.history).catch(() => {});
    }
    if (reason === 'complete') {
      S.ended = true;
      setBlink(true);
      updateHud();
      return;
    }
    resetAt(wordStart(Math.min(S.cursor, S.chars.length - 1)));
  }

  function touch() {
    S.lastKeyTime = performance.now();
    clearTimeout(S.idleTimer);
    S.idleTimer = setTimeout(() => endTest('idle'), IDLE_RESET_MS);
  }

  function flashError() {
    caret.animate([{ background: ERROR_COLOR }, { background: CARET_COLOR }], { duration: 250, easing: 'ease-out' });
  }

  function typeChar(key) {
    const { chars } = S;
    if (S.ended || S.cursor >= chars.length) return;
    if (!S.started) {
      // A test always begins at a word start, where space is a no-op anyway.
      if (key === ' ') return;
      // Must run before reading the cursor: it may relocate the caret to
      // the visible part of the page.
      startTest();
    }
    const i = S.cursor;
    const exp = chars[i].exp;

    if (key === ' ' && exp !== ' ') {
      // Space at the start of a word does nothing (monkeytype behaviour), so
      // a double-tapped space isn't punished.
      if (i === S.testStart || chars[i - 1].exp === ' ') return;
      // Space mid-word: skip the rest of the word, marking it missed.
      let j = i;
      while (j < chars.length && chars[j].exp !== ' ') setStatus(j++, MISSED);
      S.wrongKeys++;
      if (j < chars.length) setStatus(j++, CORRECT);
      S.cursor = j;
    } else {
      if (key === exp) {
        S.correctKeys++;
        setStatus(i, CORRECT);
        S.cursor++;
      } else if (exp === ' ') {
        // A letter where a space belongs. Monkeytype would render "extra"
        // letters, but that needs new DOM, so we count the miss, flash the
        // caret and hold position until you press space.
        S.wrongKeys++;
        flashError();
      } else {
        S.wrongKeys++;
        setStatus(i, WRONG);
        S.cursor++;
      }
    }
    touch();
    refreshUntyped();
    placeCaret();
    updateHud();
    if (S.cursor >= chars.length) endTest('complete');
  }

  function backspace(wholeWord) {
    if (S.ended || S.cursor <= S.testStart) return;
    const { chars, status } = S;
    let i = S.cursor;
    if (wholeWord) {
      while (i > S.testStart && chars[i - 1].exp === ' ') i--;
      while (i > S.testStart && chars[i - 1].exp !== ' ') i--;
    } else {
      i--;
      // Backing over the space after a skipped word lands you where you
      // actually stopped typing, not at the end of the skipped letters.
      if (chars[i].exp === ' ') {
        while (i > S.testStart && status[i - 1] === MISSED) i--;
      }
    }
    clearStatuses(i, S.cursor);
    S.cursor = i;
    if (S.started) touch();
    refreshUntyped();
    placeCaret();
    updateHud();
  }

  /* ------------------------------------------------------------------ *
   * Activation
   * ------------------------------------------------------------------ */
  async function activate() {
    if (S.active) return;
    S.root = findContentRoot();
    const { chars, blockStarts } = buildChars(collectBlocks(S.root));
    if (!chars.length) return;
    S.active = true;
    S.chars = chars;
    S.blockStarts = blockStarts;
    S.status = new Uint8Array(chars.length);
    S.nodeIndex = new Map();
    chars.forEach((c, i) => {
      if (c.synthetic) return;
      if (!S.nodeIndex.has(c.node)) S.nodeIndex.set(c.node, []);
      S.nodeIndex.get(c.node).push(i);
    });
    S.ended = false;
    S.lastResult = null;
    S.errorRanges.clear();

    buildOverlay();
    setupHighlights();
    S.cursor = S.testStart = firstVisibleIndex();
    refreshUntyped();
    placeCaret({ instant: true, scroll: false });
    setBlink(true);
    updateHud();
    if (!S.hl) {
      renderHud([['ready', '']], 'no text colouring: needs firefox 140+');
    }

    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', resync);
    document.addEventListener('click', onClick, true);
    S.resizeObs = new ResizeObserver(resync);
    S.resizeObs.observe(S.root);

    try { S.history = (await store.get(HISTORY_KEY)) || []; } catch (_) { S.history = []; }
    if (S.active && !S.started) updateHud();
  }

  function deactivate() {
    if (!S.active) return;
    endTest('exit');
    clearTimeout(S.idleTimer);
    clearInterval(S.hudTimer);
    setBlink(false);
    teardownHighlights();
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', resync);
    document.removeEventListener('click', onClick, true);
    S.resizeObs?.disconnect();
    host?.remove();
    host = caret = hud = null;
    S.active = false;
    S.chars = [];
    S.nodeIndex = null;
  }

  /* ------------------------------------------------------------------ *
   * Input
   * ------------------------------------------------------------------ */
  const isEditable = (t) => t instanceof Element &&
    (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onKeyDown(e) {
    if (e.isComposing || e.key === 'Dead') return;
    // Never steal keys from a search box or comment field.
    if (isEditable(e.target)) return;

    if (!S.active) {
      if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        swallow(e);
        activate();
      }
      return;
    }

    // "m" is a letter once active, so Escape is the way out.
    if (e.key === 'Escape') { swallow(e); deactivate(); return; }

    if (e.key === 'Backspace') {
      swallow(e);
      // Ctrl+Backspace (Windows/Linux) and Option/Cmd+Backspace (macOS)
      // delete a word, mirroring native text fields.
      backspace(e.ctrlKey || e.altKey || e.metaKey);
      return;
    }

    // Leave browser shortcuts (Cmd+L, Ctrl+T, ...) alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key.length === 1) {
      // Stops space from scrolling the page and the site's own shortcuts
      // (YouTube's "k", GitHub's "s", ...) from firing while you type.
      swallow(e);
      typeChar(e.key);
    }
  }

  // Click on text to move the caret there (to the start of that word).
  // Links and controls keep working normally.
  function onClick(e) {
    if (!S.active || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('a,button,input,textarea,select,label,[contenteditable]')) return;
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    const list = pos && S.nodeIndex.get(pos.offsetNode);
    if (!list) return;
    let idx = list[0];
    for (const i of list) if (S.chars[i].off <= pos.offset) idx = i;
    if (S.started) endTest('jump');
    S.ended = false;
    S.lastResult = null;
    resetAt(wordStart(idx));
  }

  // Capture phase on window: the earliest point a content script can see a
  // key, so we get in before most page handlers.
  window.addEventListener('keydown', onKeyDown, true);
})();
