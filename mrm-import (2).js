/*
 * mrm-import.js - ManhuaRMTL chapter importer for TypeR Studio
 *
 * Drop this file in: web/mrm-import.js
 * Wire it up by adding one <script> tag to web/index.html (see README).
 *
 * What it does:
 *   1. Listens for drag-drop of a chapter-*.zip (from the ManhuaRMTL userscript)
 *      anywhere on the TypeR Studio workspace.
 *   2. Unzips it, reads chapter.json.
 *   3. Loads every page PNG as an open document (so each page becomes a tab,
 *      exactly as if the user had dragged the PNGs in one by one).
 *   4. Adds a floating "MTL Reference" panel that shows the translation text
 *      for the currently active page. Clicking a line copies it to the clipboard
 *      and highlights the corresponding box overlay on the canvas.
 *   5. Draws semi-transparent reference boxes over the canvas so the typesetter
 *      can see where each translation bubble goes.
 *
 * The module is self-contained: it does not modify any existing TypeR Studio
 * files at runtime. It only calls the public workspace hooks that already exist
 * (openDocument, getActiveDocument, onDocumentChanged). If those names are
 * different in your fork, update the HOOK map at the top of the file.
 *
 * License: MIT
 */

(function () {
  'use strict';

  if (window.__mrmImportInstalled) return;
  window.__mrmImportInstalled = true;

  // -----------------------------------------------------------------
  //  Configuration: point these at your workspace's real API.
  // -----------------------------------------------------------------
  var HOOK = {
    // Function that opens an image file (Blob or File) as a new document/tab.
    // Replace the body if your workspace uses a different entry point.
    openImageBlob: function (blob, name) {
      // Default: reuse TypeR Studio's own file-input pipeline by dispatching
      // a synthetic drop event on the main workspace element. This works on
      // the stock TypeR Studio web build without needing to know internal
      // function names.
      var dt = new DataTransfer();
      var file = new File([blob], name, { type: blob.type || 'image/png' });
      dt.items.add(file);
      var el = document.querySelector('#workspace, .workspace, [data-drop-target], main');
      if (!el) el = document.body;
      var evt = new DragEvent('drop', { dataTransfer: dt, bubbles: true });
      el.dispatchEvent(evt);
      return evt;
    },
    // Return the index of the currently active document (0-based), or -1.
    getActiveIndex: function () {
      // The stock build keeps the active page index on the workspace element.
      var w = document.querySelector('#workspace, .workspace');
      if (w && w.dataset && w.dataset.activeIndex != null) {
        return parseInt(w.dataset.activeIndex, 10);
      }
      // Fallback: look for the active tab.
      var tab = document.querySelector('.tab.active, [data-tab].active');
      if (tab && tab.dataset.index != null) return parseInt(tab.dataset.index, 10);
      return -1;
    },
    // Subscribe to document switches. Calls cb(newIndex) when the active page
    // changes. Return an unsubscribe function.
    onActiveChanged: function (cb) {
      var observer = new MutationObserver(function () {
        cb(HOOK.getActiveIndex());
      });
      var target = document.querySelector('#workspace, .workspace, .tabs, main') || document.body;
      observer.observe(target, { attributes: true, subtree: true, attributeFilter: ['class', 'data-active-index', 'data-index'] });
      return function () { observer.disconnect(); };
    },
    // Return the canvas element the workspace is currently rendering into, or
    // null. We draw our reference overlay on top of this canvas.
    getActiveCanvas: function () {
      return document.querySelector('canvas.workspace-canvas, #workspace canvas, .document canvas');
    }
  };

  // -----------------------------------------------------------------
  //  Internal state
  // -----------------------------------------------------------------
  var state = {
    manifest: null,        // chapter.json contents
    images: [],            // [{name, url}] in page order
    activeIdx: -1,
    overlays: []           // currently drawn overlay divs
  };

  var panel = null;        // floating reference panel
  var overlayLayer = null; // div above the workspace canvas

  // -----------------------------------------------------------------
  //  Drag & drop on the whole document
  // -----------------------------------------------------------------
  function isZipFile(file) {
    return file && (/\.zip$/i.test(file.name) || file.type === 'application/zip');
  }

  function installDropHandler() {
    window.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.slice.call(e.dataTransfer.types || []).indexOf('Files') >= 0) {
        e.preventDefault();
      }
    });

    window.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      var zip = null;
      for (var i = 0; i < e.dataTransfer.files.length; i++) {
        if (isZipFile(e.dataTransfer.files[i])) { zip = e.dataTransfer.files[i]; break; }
      }
      if (!zip) return;
      // Only intercept if it looks like a ManhuaRMTL chapter zip.
      if (!/chapter|manhuarmtl/i.test(zip.name)) return;
      e.preventDefault();
      e.stopPropagation();
      loadChapterZip(zip);
    }, true);
  }

  // -----------------------------------------------------------------
  //  ZIP loading
  // -----------------------------------------------------------------
  // JSZip is already loaded by TypeR Studio (in styles.js / kit.js). If it
  // is not, we load it lazily here.
  function ensureJSZip() {
    return new Promise(function (resolve, reject) {
      if (window.JSZip) return resolve(window.JSZip);
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = function () { resolve(window.JSZip); };
      s.onerror = function () { reject(new Error('Failed to load JSZip')); };
      document.head.appendChild(s);
    });
  }

  async function loadChapterZip(file) {
    try {
      var JSZip = await ensureJSZip();
      var zip = await JSZip.loadAsync(file);

      var manifestFile = zip.file('chapter.json');
      if (!manifestFile) {
        alert('Not a ManhuaRMTL chapter ZIP: chapter.json missing.');
        return;
      }
      var manifest = JSON.parse(await manifestFile.async('string'));
      if (!manifest.pages || !manifest.pages.length) {
        alert('chapter.json has no pages.');
        return;
      }

      // Extract images in order.
      var images = [];
      for (var i = 0; i < manifest.pages.length; i++) {
        var p = manifest.pages[i];
        var entry = zip.file('images/' + p.imageFilename);
        if (!entry) { images.push(null); continue; }
        var blob = await entry.async('blob');
        var url = URL.createObjectURL(blob);
        images.push({ name: p.imageFilename, url: url, blob: blob });
      }

      state.manifest = manifest;
      state.images = images;

      // Open every page as a document, in order. TypeR Studio's drop handler
      // will create one tab per file.
      for (var j = 0; j < images.length; j++) {
        if (!images[j]) continue;
        HOOK.openImageBlob(images[j].blob, images[j].name);
      }

      // Build the reference panel.
      buildPanel();
      buildOverlayLayer();

      // Track active page changes.
      HOOK.onActiveChanged(function (idx) {
        setActive(idx);
      });

      // Try to sync to whatever page is active right now.
      setActive(HOOK.getActiveIndex());

      console.log('[MRM Import] loaded chapter:', manifest.title, '(' + images.length + ' pages)');
    } catch (err) {
      console.error('[MRM Import] load failed:', err);
      alert('Failed to load chapter ZIP: ' + (err.message || err));
    }
  }

  // -----------------------------------------------------------------
  //  Reference panel
  // -----------------------------------------------------------------
  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'mrm-reference-panel';
    panel.style.cssText = [
      'position: fixed',
      'top: 120px',
      'right: 16px',
      'width: 300px',
      'max-height: 60vh',
      'background: #26202e',
      'color: #ece6f0',
      'border: 1px solid #43374f',
      'border-radius: 10px',
      'box-shadow: 0 8px 24px rgba(0,0,0,0.4)',
      'z-index: 999998',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'display: flex',
      'flex-direction: column',
      'overflow: hidden'
    ].join(';');

    var header = document.createElement('div');
    header.style.cssText = 'padding:10px 12px;background:#322a3d;border-bottom:1px solid #43374f;font-weight:700;font-size:13px;cursor:move;display:flex;justify-content:space-between;align-items:center';
    var titleText = 'MTL Reference';
    if (state.manifest) {
      var lang = state.manifest.targetLang || 'en';
      var langLabel = lang === 'ar' ? ' (AR)' : lang === 'bi' ? ' (EN|AR)' : ' (EN)';
      titleText += langLabel;
    }
    header.innerHTML = '<span>' + titleText + '</span><span id="mrm-panel-close" style="cursor:pointer;font-size:18px;line-height:1">&times;</span>';
    panel.appendChild(header);

    var body = document.createElement('div');
    body.id = 'mrm-panel-body';
    body.style.cssText = 'padding:8px;overflow-y:auto;flex:1;font-size:13px';
    panel.appendChild(body);

    document.body.appendChild(panel);

    $('#mrm-panel-close', panel).addEventListener('click', function () {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });

    makeDraggable(panel, header);
  }

  function makeDraggable(el, handle) {
    var dx = 0, dy = 0, sx = 0, sy = 0;
    handle.addEventListener('mousedown', function (e) {
      var rect = el.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      sx = e.clientX; sy = e.clientY;
      function move(ev) {
        el.style.left = (ev.clientX - dx) + 'px';
        el.style.top = (ev.clientY - dy) + 'px';
        el.style.right = 'auto';
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function $(sel, root) { return (root || document).querySelector(sel); }

  // -----------------------------------------------------------------
  //  Overlay layer (reference boxes drawn on the canvas)
  // -----------------------------------------------------------------
  function buildOverlayLayer() {
    if (overlayLayer) return;
    overlayLayer = document.createElement('div');
    overlayLayer.id = 'mrm-overlay-layer';
    overlayLayer.style.cssText = [
      'position: absolute',
      'pointer-events: none',
      'z-index: 100'
    ].join(';');
    document.body.appendChild(overlayLayer);
  }

  function clearOverlays() {
    if (!overlayLayer) return;
    while (overlayLayer.firstChild) overlayLayer.removeChild(overlayLayer.firstChild);
    state.overlays = [];
  }

  function drawOverlays(page) {
    clearOverlays();
    if (!page || !page.texts || !page.texts.length) return;

    var canvas = HOOK.getActiveCanvas();
    if (!canvas) return;
    var canvasRect = canvas.getBoundingClientRect();

    // Position the overlay layer exactly over the canvas.
    overlayLayer.style.left = canvasRect.left + 'px';
    overlayLayer.style.top = canvasRect.top + 'px';
    overlayLayer.style.width = canvasRect.width + 'px';
    overlayLayer.style.height = canvasRect.height + 'px';

    // In stitched mode the active canvas shows the whole stitched PNG (which
    // contains many pages). Each page's boxes are in source-image coordinates;
    // convert to stitched-image px, then scale to the displayed canvas size.
    var stitched = !!page.stitchedOffset;
    var canvasW = page.canvasWidth || page.width;
    var canvasH = page.canvasHeight || page.height;
    var srcScaleX = canvasW / page.width;    // source px -> stitched px (usually 1)
    var srcScaleY = canvasH / page.height;
    var offX = stitched ? page.stitchedOffset.x : 0;
    var offY = stitched ? page.stitchedOffset.y : 0;
    // Stitched-image px -> displayed px.
    var scaleX, scaleY;
    if (stitched) {
      // The canvas's natural size is the stitched image's pixel size; the
      // displayed size is what the user sees. We scale boxes relative to the
      // whole stitched image.
      scaleX = canvasRect.width / canvasW;
      scaleY = canvasRect.height / canvasH;
      // But boxes are per-page, so we also add the page's offset inside the
      // stitched image (already in stitched-image px).
      // Final: left = (box.x * srcScaleX + offX) * scaleX
      // We pre-fold srcScale into scaleX/Y since srcScale is usually 1.
      scaleX *= srcScaleX;
      scaleY *= srcScaleY;
    } else {
      scaleX = canvasRect.width / page.width;
      scaleY = canvasRect.height / page.height;
    }

    page.texts.forEach(function (t, i) {
      var box = document.createElement('div');
      box.style.cssText = [
        'position: absolute',
        'left:' + (t.box.x * scaleX + offX * (stitched ? (canvasRect.width / canvasW) : 1)) + 'px',
        'top:' + (t.box.y * scaleY + offY * (stitched ? (canvasRect.height / canvasH) : 1)) + 'px',
        'width:' + (t.box.w * scaleX) + 'px',
        'height:' + (t.box.h * scaleY) + 'px',
        'border: 1.5px solid rgba(155,89,182,0.7)',
        'background: rgba(155,89,182,0.1)',
        'border-radius: 3px',
        'cursor: pointer',
        'pointer-events: auto',
        'box-sizing: border-box'
      ].join(';');
      box.title = pickText(t);
      box.dataset.idx = i;
      box.addEventListener('click', function (e) {
        e.stopPropagation();
        copyToClipboard(pickCopyText(t));
        highlightInPanel(i);
      });
      overlayLayer.appendChild(box);
      state.overlays.push(box);
    });
  }

  // Re-position the overlay layer when the workspace scrolls / resizes.
  function repositionOverlay() {
    if (!state.manifest) return;
    var page = state.manifest.pages[state.activeIdx];
    if (page) drawOverlays(page);
  }
  window.addEventListener('resize', repositionOverlay);
  window.addEventListener('scroll', repositionOverlay, true);
  setInterval(repositionOverlay, 1000); // cheap safety net

  // -----------------------------------------------------------------
  //  Active page sync
  // -----------------------------------------------------------------
  function setActive(idx) {
    if (idx === state.activeIdx || idx < 0 || !state.manifest) return;
    state.activeIdx = idx;
    var page = state.manifest.pages[idx];
    if (!page) return;
    renderPanelBody(page);
    drawOverlays(page);
  }

  // Pick the right text field for display, based on the manifest's targetLang.
  // The userscript sets targetLang = 'en' | 'ar' | 'bi' and also stores a
  // pre-computed displayText on every text entry, so we just fall back to it.
  function pickText(t) {
    if (!t) return '';
    if (t.displayText != null) return t.displayText;
    var lang = (state.manifest && state.manifest.targetLang) || 'en';
    if (lang === 'en') return t.sourceText || t.text || '';
    if (lang === 'ar') return t.text || t.sourceText || '';
    var en = t.sourceText || '';
    var ar = t.isTranslated ? t.text : '';
    return ar ? ('EN: ' + en + '  |  AR: ' + ar) : (en + '  [ untranslated ]');
  }

  // For clipboard copy: when targetLang is 'bi', copy only the AR part so the
  // typesetter can paste it straight into an Arabic bubble. For 'en', copy
  // English. For 'ar', copy Arabic.
  function pickCopyText(t) {
    if (!t) return '';
    var lang = (state.manifest && state.manifest.targetLang) || 'en';
    if (lang === 'en') return t.sourceText || t.text || '';
    if (lang === 'ar') return t.text || t.sourceText || '';
    // bi: prefer Arabic if it exists, else English.
    return (t.isTranslated && t.text) ? t.text : (t.sourceText || '');
  }

  function renderPanelBody(page) {
    var body = $('#mrm-panel-body');
    if (!body) return;
    body.innerHTML = '';

    var lang = (state.manifest && state.manifest.targetLang) || 'en';
    var langName = lang === 'ar' ? 'Arabic' : lang === 'bi' ? 'Bilingual' : 'English';

    var header = document.createElement('div');
    header.style.cssText = 'font-size:11px;color:#a89bb5;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em';
    header.textContent = 'Page ' + (page.index + 1) + ' / ' + state.manifest.pageCount +
                         ' (' + (page.texts || []).length + ' texts)' +
                         '  [' + langName + ']';
    body.appendChild(header);

    // Show a warning banner if the user asked for Arabic but translation
    // didn't actually run on the source page.
    if (lang === 'ar' && state.manifest.translation && state.manifest.translation.insufficient) {
      var warn = document.createElement('div');
      warn.style.cssText = 'background:#c0392b;color:#fff;padding:6px 8px;border-radius:6px;font-size:11px;margin-bottom:8px;line-height:1.4';
      warn.textContent = 'Warning: few texts were translated. Re-extract after enabling Chrome "Translate to Arabic" on the chapter page.';
      body.appendChild(warn);
    }

    if (!page.texts || !page.texts.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:#a89bb5;font-size:12px';
      empty.textContent = 'No translation text on this page.';
      body.appendChild(empty);
      return;
    }

    page.texts.forEach(function (t, i) {
      var item = document.createElement('div');
      item.dataset.idx = i;
      item.style.cssText = 'background:#322a3d;border:1px solid #43374f;border-radius:6px;padding:8px 10px;margin-bottom:6px;cursor:pointer;transition:background .15s ease';
      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:10px;color:#a89bb5;margin-bottom:3px;display:flex;gap:4px;flex-wrap:wrap';
      meta.innerHTML =
        '<span style="background:#43374f;padding:1px 5px;border-radius:999px">#' + (i + 1) + '</span>' +
        (t.kind ? '<span style="background:#43374f;padding:1px 5px;border-radius:999px">' + escapeHtml(t.kind) + '</span>' : '') +
        (t.style && t.style.length ? t.style.map(function (s) {
          return '<span style="background:#43374f;padding:1px 5px;border-radius:999px">' + escapeHtml(s) + '</span>';
        }).join('') : '');
      item.appendChild(meta);

      var text = document.createElement('div');
      text.style.cssText = 'font-size:12px;line-height:1.4;word-break:break-word';
      if (t.dir === 'rtl') {
        text.style.direction = 'rtl';
        text.style.textAlign = 'right';
      }
      text.textContent = pickText(t);
      item.appendChild(text);

      item.addEventListener('mouseenter', function () { item.style.background = '#9b59b6'; });
      item.addEventListener('mouseleave', function () { item.style.background = '#322a3d'; });
      item.addEventListener('click', function () {
        copyToClipboard(pickCopyText(t));
        highlightOverlay(i);
      });

      body.appendChild(item);
    });
  }

  function highlightOverlay(idx) {
    state.overlays.forEach(function (n, i) {
      n.style.borderColor = i === idx ? '#27ae60' : 'rgba(155,89,182,0.7)';
      n.style.background = i === idx ? 'rgba(39,174,96,0.25)' : 'rgba(155,89,182,0.1)';
    });
  }

  function highlightInPanel(idx) {
    var body = $('#mrm-panel-body');
    if (!body) return;
    Array.prototype.slice.call(body.querySelectorAll('[data-idx]')).forEach(function (n) {
      n.style.background = parseInt(n.dataset.idx, 10) === idx ? '#27ae60' : '#322a3d';
    });
    var active = body.querySelector('[data-idx="' + idx + '"]');
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // -----------------------------------------------------------------
  //  Clipboard
  // -----------------------------------------------------------------
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showToast, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast(); } catch (e) {}
    document.body.removeChild(ta);
  }
  function showToast() {
    var t = document.getElementById('mrm-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mrm-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#27ae60;color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;opacity:0;transition:opacity .2s ease, transform .2s ease;z-index:999999;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
      document.body.appendChild(t);
    }
    t.textContent = 'Copied!';
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(t._timer);
    t._timer = setTimeout(function () {
      t.style.opacity = '0';
      t.style.transform = 'translateX(-50%) translateY(20px)';
    }, 1200);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // -----------------------------------------------------------------
  //  Boot
  // -----------------------------------------------------------------
  installDropHandler();
  console.log('[MRM Import] installed. Drop a chapter-*.zip anywhere to load.');
})();
