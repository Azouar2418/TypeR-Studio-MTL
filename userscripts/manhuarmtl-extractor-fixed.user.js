// ==UserScript==
// @name         ManhuaRMTL -> TypeR Studio Extractor
// @namespace    https://github.com/Azouar2418/TypeR-Studio-MTL
// @version      1.3.0
// @description  Extract chapter images (decrypted canvases) + translation boxes (positions, styles, colors, fonts) from manhuarmtl.com as a ZIP for TypeR Studio or standalone viewer. Language selector: EN / AR / Bilingual. Stitch mode + shadow-canvas fallback for tainted/blocked canvases.
// @author       Azouar
// @match        https://manhuarmtl.com/manga/*/*
// @match        https://manhuarmtl.com/manga/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ==================================================================
    //  PHASE 1 — Shadow-canvas hooks (must run BEFORE the v9 script)
    // ==================================================================
    //  The v9 protection draws each decrypted page onto a <canvas> via
    //  ctx.drawImage(imageBitmap, 0, 0, w, h). On some browsers / with some
    //  privacy extensions (CanvasBlocker, Brave's fingerprinting protection,
    //  strict Firefox settings) the resulting canvas is "tainted" or its
    //  toBlob / toDataURL / getImageData are blocked — so our extraction
    //  gets null and the whole chapter fails.
    //
    //  Fix: hook CanvasRenderingContext2D.prototype.drawImage so that every
    //  time the v9 script draws a page, we ALSO draw the same image onto a
    //  fresh <canvas> we created ourselves. That shadow canvas is same-origin
    //  (the ImageBitmap came from a same-origin Blob), not fingerprinted, and
    //  not tainted — so toBlob works on it even when it fails on the v9
    //  canvas.
    //
    //  The hook is installed at @run-at document-start, before any page
    //  script runs, so it sees every drawImage call the v9 VM makes.
    // ==================================================================

    // canvas element -> { shadow: HTMLCanvasElement, drawn: boolean }
    var shadowCanvases = new WeakMap();

    // Save the real drawImage before anything else can touch it.
    var _origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    var _origGetContext = HTMLCanvasElement.prototype.getContext;

    // Wrap getContext so we can spot when a 2d context is requested on a
    // mrm-v9-canvas and prepare a shadow canvas for it. (We can't create the
    // shadow here because we don't yet know the target size; we just mark
    // the canvas as one we care about.)
    HTMLCanvasElement.prototype.getContext = function (contextType) {
        var ctx = _origGetContext.apply(this, arguments);
        // Only track 2d contexts on v9 chapter canvases.
        if (contextType === '2d' || contextType === '2d') {
            if (this && this.classList && this.classList.contains('mrm-v9-canvas')) {
                if (!shadowCanvases.has(this)) {
                    shadowCanvases.set(this, { shadow: null, drawn: false });
                }
            }
        }
        return ctx;
    };

    // Wrap drawImage so we can mirror every draw onto a shadow canvas.
    CanvasRenderingContext2D.prototype.drawImage = function (image) {
        // Always call the original first — the page must render normally.
        var result = _origDrawImage.apply(this, arguments);

        // Now mirror onto a shadow canvas if this is a v9 chapter canvas.
        var canvas = this.canvas;
        if (!canvas || !canvas.classList || !canvas.classList.contains('mrm-v9-canvas')) {
            return result;
        }

        try {
            var entry = shadowCanvases.get(canvas);
            if (!entry) {
                entry = { shadow: null, drawn: false };
                shadowCanvases.set(canvas, entry);
            }
            // Only capture the first successful draw — the v9 code only draws
            // each page once, and re-drawing would just waste cycles.
            if (entry.drawn) return result;

            // Create the shadow canvas at the same pixel size as the v9 canvas.
            var shadow = document.createElement('canvas');
            shadow.width = canvas.width;
            shadow.height = canvas.height;
            var sctx = _origGetContext.call(shadow, '2d');
            // Re-run the EXACT same drawImage call on our shadow canvas.
            // image is the same ImageBitmap / HTMLImageElement the v9 code
            // decoded from the decrypted same-origin Blob, so our shadow
            // canvas is same-origin and not tainted.
            _origDrawImage.apply(sctx, arguments);
            entry.shadow = shadow;
            entry.drawn = true;
        } catch (e) {
            // If the shadow draw fails for any reason, don't break the page —
            // we still have the original canvas to fall back to.
            console.warn('[MRM Extractor] shadow draw failed:', e);
        }

        return result;
    };

    // ==================================================================
    //  PHASE 2 — Config, helpers, extraction logic
    // ==================================================================

    // ------------------------------------------------------------------
    //  Config
    // ------------------------------------------------------------------
    var CFG = {
        // Only act on URLs that look like a chapter page.
        chapterPattern: /\/manga\/[^/]+\/chapter-\d+/i,
        // How long to wait for lazy pages before extracting anyway.
        readyTimeoutMs: 180000, // 3 minutes
        // Polling interval while waiting for canvases.
        pollIntervalMs: 1000,
        // Small delay between pages so the UI can repaint.
        yieldMs: 20,
        // Maximum canvas pixels before we warn about size.
        warnPixels: 16000000,
        // localStorage key for the chosen output language.
        langKey: 'mrm-extractor-lang',
        // localStorage key for stitch mode.
        stitchKey: 'mrm-extractor-stitch',
        // Safe upper bound for a single stitched canvas. Chrome's hard limit
        // is ~268M pixels (16384x16384), Safari's is much lower (~16M). We
        // stay under 100M so a single stitched PNG works everywhere; if the
        // chapter is bigger we split into multiple stitched images.
        maxStitchPixels: 100000000
    };

    // ------------------------------------------------------------------
    //  Stitch mode: 'separate' | 'vertical' | 'horizontal'
    // ------------------------------------------------------------------
    //  separate  = one PNG per page (the original behaviour)
    //  vertical  = stack pages top-to-bottom into one tall PNG
    //  horizontal= lay pages side-by-side into one wide PNG
    //
    //  Stitching is lossless (PNG, drawImage copies pixels verbatim). Every
    //  stitched image becomes one ordinary exported page. During ZIP creation,
    //  each source page's text boxes are translated into that image's coordinate
    //  space and combined into one pages[] entry. TypeR therefore needs no
    //  stitchedOffset support or second coordinate-conversion pass.
    //
    //  If the chapter is too big for one canvas (> maxStitchPixels), it is split
    //  into multiple stitched images, each exported as its own numbered page.
    // ------------------------------------------------------------------
    function getStitchMode() {
        try {
            var v = localStorage.getItem(CFG.stitchKey);
            if (v === 'separate' || v === 'vertical' || v === 'horizontal') return v;
        } catch (e) {}
        return 'separate';
    }
    function setStitchMode(v) {
        try { localStorage.setItem(CFG.stitchKey, v); } catch (e) {}
    }
    var stitchMode = getStitchMode();

    // ------------------------------------------------------------------
    //  Output language: 'en' | 'ar' | 'bi'
    // ------------------------------------------------------------------
    //  en = English only (uses dataset.text, always available)
    //  ar = Arabic only (uses the span text — requires Chrome's
    //       "Translate to Arabic" to have been active when the page loaded)
    //  bi = Bilingual: each text becomes "EN: ... | AR: ..."
    //
    //  The choice is persisted in localStorage so the user does not have to
    //  re-pick it on every chapter. The manifest carries targetLang so the
    //  TypeR Studio importer and the reference viewer know which field to
    //  show.
    // ------------------------------------------------------------------
    function getTargetLang() {
        try {
            var v = localStorage.getItem(CFG.langKey);
            if (v === 'en' || v === 'ar' || v === 'bi') return v;
        } catch (e) {}
        return 'en'; // safest default — always works
    }
    function setTargetLang(v) {
        try { localStorage.setItem(CFG.langKey, v); } catch (e) {}
    }
    var targetLang = getTargetLang();

    // Which field on each text object is the "primary" display text for the
    // chosen language. The importer / viewer use this.
    function primaryFieldFor(lang) {
        return lang === 'en' ? 'sourceText' : 'text';
    }

    // Build the display string for a text given the chosen language.
    function displayTextFor(t, lang) {
        if (!t) return '';
        if (lang === 'en') return t.sourceText || t.text || '';
        if (lang === 'ar') return t.text || t.sourceText || '';
        // bi
        var en = t.sourceText || '';
        var ar = t.isTranslated ? t.text : '';
        if (!ar) return en + '  [ untranslated ]';
        return 'EN: ' + en + '  |  AR: ' + ar;
    }

    // ------------------------------------------------------------------
    //  Helpers
    // ------------------------------------------------------------------
    function isChapterPage() {
        return CFG.chapterPattern.test(location.pathname);
    }

    function getChapterTitle() {
        var h1 = document.querySelector('#chapter-heading');
        if (h1) return h1.textContent.trim();
        return document.title.replace(/\s*-\s*ManhuaRMTL.*$/i, '').trim();
    }

    function getChapterSlug() {
        var parts = location.pathname.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : 'chapter';
    }

    function getMangaSlug() {
        var parts = location.pathname.split('/').filter(Boolean);
        // /manga/<slug>/chapter-N
        if (parts.length >= 3 && parts[1]) return parts[1];
        return 'manga';
    }

    function allCanvases() {
        return Array.prototype.slice.call(
            document.querySelectorAll('canvas.mrm-v9-canvas')
        );
    }

    function readyCanvases() {
        return allCanvases().filter(function (c) {
            return c.dataset.mrmReady === '1';
        });
    }

    function isEverythingReady() {
        var list = allCanvases();
        if (!list.length) return false;
        return list.every(function (c) {
            return c.dataset.mrmReady === '1';
        });
    }

    // canvas.toBlob() promise wrapper
    function canvasToBlob(canvas) {
        return new Promise(function (resolve, reject) {
            try {
                canvas.toBlob(function (blob) {
                    if (blob) resolve(blob);
                    else reject(new Error('toBlob returned null (canvas tainted?)'));
                }, 'image/png');
            } catch (e) {
                reject(e);
            }
        });
    }

    // Quick taint check — reads one pixel. If this throws, the canvas is
    // tainted or readback is blocked, and we should skip straight to the
    // shadow canvas fallback.
    function isCanvasReadable(canvas) {
        try {
            var ctx = canvas.getContext('2d');
            if (!ctx) return false;
            ctx.getImageData(0, 0, 1, 1);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Extract a page image with a multi-tier fallback:
    //   1. toBlob on the v9 canvas  (works in most browsers, no extension)
    //   2. toBlob on the shadow canvas we captured during drawImage
    //      (works even if the v9 canvas is tainted / blocked by privacy
    //      extensions, because the shadow canvas is our own, same-origin)
    //   3. toDataURL on the shadow canvas as a last resort
    //
    // Returns { blob, source } where source tells you which tier worked, or
    // throws if every tier failed.
    async function extractCanvasImage(canvas) {
        // Tier 1: the v9 canvas directly.
        if (canvas && canvas.width > 0 && canvas.height > 0 && isCanvasReadable(canvas)) {
            try {
                var blob = await canvasToBlob(canvas);
                return { blob: blob, source: 'v9-canvas' };
            } catch (e) {
                console.warn('[MRM Extractor] v9 canvas toBlob failed, trying shadow:', e);
            }
        }

        // Tier 2: the shadow canvas we mirrored during drawImage.
        var entry = shadowCanvases.get(canvas);
        if (entry && entry.shadow) {
            var shadow = entry.shadow;
            if (shadow.width > 0 && shadow.height > 0) {
                if (isCanvasReadable(shadow)) {
                    try {
                        var sblob = await canvasToBlob(shadow);
                        return { blob: sblob, source: 'shadow-canvas' };
                    } catch (e) {
                        console.warn('[MRM Extractor] shadow toBlob failed:', e);
                    }
                }
                // Tier 3: toDataURL as a last resort.
                try {
                    var dataUrl = shadow.toDataURL('image/png');
                    if (dataUrl && dataUrl.indexOf('data:image/png') === 0) {
                        var b64 = dataUrl.split(',')[1];
                        // Convert base64 to a Blob.
                        var byteChars = atob(b64);
                        var byteNumbers = new Array(byteChars.length);
                        for (var i = 0; i < byteChars.length; i++) {
                            byteNumbers[i] = byteChars.charCodeAt(i);
                        }
                        var ua = new Uint8Array(byteNumbers);
                        var dblob = new Blob([ua], { type: 'image/png' });
                        return { blob: dblob, source: 'shadow-dataurl' };
                    }
                } catch (e2) {
                    console.warn('[MRM Extractor] shadow toDataURL also failed:', e2);
                }
            }
        }

        // Every tier failed — this page can't be extracted.
        throw new Error('All extraction tiers failed (canvas tainted and no shadow available)');
    }

    // Read a Blob as base64 (without data: prefix)
    function blobToBase64(blob) {
        return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () {
                var s = fr.result || '';
                var i = s.indexOf(',');
                resolve(i >= 0 ? s.slice(i + 1) : s);
            };
            fr.onerror = reject;
            fr.readAsDataURL(blob);
        });
    }

    // Convert "#rrggbb" to {r,g,b}
    function hexToRgb(hex) {
        if (!hex || typeof hex !== 'string') return null;
        var m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
        if (!m) return null;
        var n = parseInt(m[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    // ------------------------------------------------------------------
    //  Page extraction
    // ------------------------------------------------------------------
    // Each <canvas class="mrm-v9-canvas"> has:
    //   dataset.src          = "pg_<hex>.dat"   (the per-load page token)
    //   dataset.mrmIdx        = "0".."N-1"
    //   dataset.mrmReady      = "1" once drawn
    //   dataset.natW/natH     = source image dimensions (may differ from
    //                           canvas.width/height when the source was
    //                           downscaled to fit the browser canvas limit)
//
    // Each overlay (.manga-ocr-button-overlay) has:
    //   id                    = "ocr-text-<sanitised filename>-<index>"
    //   style.left            = center X in reading-content px
    //   style.top             = top Y in reading-content px
    //   dataset.boxWidth      = scaled box width (display px)
    //   dataset.boxHeight     = scaled box height (display px)
    //   dataset.text          = translation text
    //   dataset.kind          = dialogue|thought|narration|sfx_bubble|sign|...
    //   dataset.style         = comma list: large,small,bold,italic,...
    //   dataset.fill          = #rrggbb
    //   dataset.outline       = #rrggbb
    //   dataset.background    = #rrggbb
    //   dataset.colorConfidence = 0..1
    //   dataset.baseFontSize  = px
    //   dataset.maxWidth      = px (neighbour-limited max width)
    //   dataset.pageWidth     = canvas.offsetWidth at layout time
    //   dataset.capSize       = px (harmonisation cap)
//
    // The overlay is centred horizontally on style.left (CSS transform
    // translateX(-50%)), so the box's left edge is:
    //   centerX - boxWidth/2
    // ------------------------------------------------------------------

    function findOverlaysForCanvas(canvas) {
        var src = canvas.dataset.src || '';
        var filename = src.split('/').pop().split('?')[0];
        var sanitized = filename.replace(/[^a-z0-9]/gi, '_');
        // The OCR overlay IDs are built as: ocr-text-<sanitized>-<index>
        // The sanitiser in the page drops the dot, so "pg_xxx.dat" -> "pg_xxx_dat".
        var prefix = 'ocr-text-' + sanitized + '-';
        return Array.prototype.slice.call(
            document.querySelectorAll('[id^="' + prefix + '"]')
        );
    }

    function getReadingContainer() {
        return document.querySelector('.reading-content');
    }

    function extractPage(canvas, pageIndex) {
        var natW = parseInt(canvas.dataset.natW || canvas.width, 10);
        var natH = parseInt(canvas.dataset.natH || canvas.height, 10);
        var displayW = canvas.offsetWidth || natW;
        var displayH = canvas.offsetHeight || natH;
        // Scale from display px -> source image px.
        var scaleX = natW / displayW;
        var scaleY = natH / displayH;

        var src = canvas.dataset.src || '';
        var sourceFilename = src.split('/').pop().split('?')[0];

        // Canvas position inside .reading-content (matches the page's own layout
        // math, so the boxes come out in the same coordinate space as the
        // original OCR data).
        var container = getReadingContainer();
        var canvasRect = canvas.getBoundingClientRect();
        var containerRect = container.getBoundingClientRect();
        var canvasLeftInContainer =
            canvasRect.left - containerRect.left + container.scrollLeft;
        var canvasTopInContainer =
            canvasRect.top - containerRect.top + container.scrollTop;

        var overlays = findOverlaysForCanvas(canvas);
        var texts = [];

        overlays.forEach(function (ov) {
            var styleLeft = parseFloat(ov.style.left);  // center X, container px
            var styleTop = parseFloat(ov.style.top);     // top Y, container px
            var boxW = parseFloat(ov.dataset.boxWidth) || 0;
            var boxH = parseFloat(ov.dataset.boxHeight) || 0;

            if (!isFinite(styleLeft) || !isFinite(styleTop)) {
                // User might have dragged it (left/top set as strings with 'px')
                styleLeft = parseFloat(ov.style.left) || 0;
                styleTop = parseFloat(ov.style.top) || 0;
            }

            // Relative to canvas, in display px.
            var centerXRel = styleLeft - canvasLeftInContainer;
            var topRel = styleTop - canvasTopInContainer;

            // Convert to source image px.
            var centerSourceX = centerXRel * scaleX;
            var topSourceY = topRel * scaleY;
            var widthSource = boxW * scaleX;
            var heightSource = boxH * scaleY;
            var leftSourceX = centerSourceX - widthSource / 2;

            var cs = getComputedStyle(ov);

            // Translate CSS text-shadow (the 4-direction outline) back into a
            // stroke colour/size for typesetters. The page draws the outline as
            // four hard shadows of equal size, so we can read one offset's size
            // and assume the colour is uniform.
            var ts = cs.textShadow || '';
            var strokeMatch = ts.match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+0\s+(#[0-9a-f]{3,8}|rgba?\([^)]+\))/i);

            // --- Text capture: source vs displayed ---
            // The site stores the English MTL text in dataset.text (a data
            // attribute the browser translator never touches). The visible text
            // lives in the <span> child, which the browser translator WILL
            // rewrite to Arabic / any target language.
            //
            // We capture BOTH so the manifest always carries the source, and
            // whichever translation the user happened to have active.
            var spanEl = ov.querySelector('span');
            var sourceText = ov.dataset.text != null ? ov.dataset.text : '';
            var displayedText = spanEl ? spanEl.textContent.trim()
                                       : (ov.textContent || '').trim();
            if (!displayedText) displayedText = sourceText;
            var isTranslated = !!sourceText && displayedText !== sourceText;

            // Detect writing direction. Arabic -> 'rtl'. The page's overlays
            // inherit 'ltr' unless a translator flipped them.
            var dir = cs.direction || 'ltr';
            // Heuristic: if the text contains Arabic characters, force RTL even
            // if the computed style didn't catch it.
            if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(displayedText)) {
                dir = 'rtl';
            }

            texts.push({
                text: displayedText,            // عربي لو الترجمة مفعّلة
                sourceText: sourceText,         // الإنجليزي الأصلي (دائماً)
                displayText: displayTextFor({
                    text: displayedText,
                    sourceText: sourceText,
                    isTranslated: isTranslated
                }, targetLang),                 // النص اللي TypeR و الـ viewer هيظهروه
                isTranslated: isTranslated,
                lang: isTranslated ? null : 'en',
                dir: dir,
                box: {
                    x: Math.round(leftSourceX),
                    y: Math.round(topSourceY),
                    w: Math.round(widthSource),
                    h: Math.round(heightSource)
                },
                kind: ov.dataset.kind || '',
                style: (ov.dataset.style || '').split(',').filter(Boolean),
                color: {
                    fill: ov.dataset.fill || null,
                    outline: ov.dataset.outline || null,
                    background: ov.dataset.background || null,
                    confidence: parseFloat(ov.dataset.colorConfidence) || null
                },
                layout: {
                    baseFontSize: parseFloat(ov.dataset.baseFontSize) || null,
                    maxWidth: parseFloat(ov.dataset.maxWidth) || null,
                    capSize: parseFloat(ov.dataset.capSize) || null,
                    pageWidth: parseFloat(ov.dataset.pageWidth) || null
                },
                computed: {
                    fontFamily: cs.fontFamily,
                    fontSize: parseFloat(cs.fontSize) || null,
                    fontWeight: cs.fontWeight,
                    fontStyle: cs.fontStyle,
                    textTransform: cs.textTransform,
                    textAlign: cs.textAlign,
                    color: cs.color,
                    lineHeight: cs.lineHeight,
                    letterSpacing: cs.letterSpacing
                },
                stroke: strokeMatch ? {
                    size: parseFloat(strokeMatch[1]),
                    color: strokeMatch[3]
                } : null
            });
        });

        // Sort texts top-to-bottom, then left-to-right (reading order).
        texts.sort(function (a, b) {
            if (Math.abs(a.box.y - b.box.y) > 5) return a.box.y - b.box.y;
            return a.box.x - b.box.x;
        });

        return {
            index: pageIndex,
            sourceFilename: sourceFilename,
            imageFilename: 'page-' + String(pageIndex + 1).padStart(3, '0') + '.png',
            width: natW,
            height: natH,
            textCount: texts.length,
            texts: texts
        };
    }

    // ------------------------------------------------------------------
    //  Stitching
    // ------------------------------------------------------------------
    // Combine multiple page canvases into one (or a few, if the chapter is
    // bigger than the browser's canvas limit). Returns an array of
    // { canvas, offsets, width, height, pageIndices } chunks.
    //
    // offsets[i] is the (x, y) position of source page pageIndices[i] inside
    // the chunk canvas, measured in output pixels. buildZip uses these offsets
    // to rewrite every text box into the final page coordinate space before
    // writing chapter.json.
    //
    // PNG stitching is lossless: drawImage copies pixels verbatim, and we
    // toBlob('image/png') the result, so no re-compression happens.
    //
    // For each page, we use the SHADOW canvas if the v9 canvas is tainted
    // (the shadow is the same image drawn on our own canvas — see the hook
    // at the top of the file). This keeps stitching working even when the
    // privacy extension blocks readback on the v9 canvas.
    function getDrawableCanvas(canvas) {
        // Prefer the v9 canvas if it's readable.
        if (canvas && isCanvasReadable(canvas)) return canvas;
        // Otherwise fall back to the shadow canvas.
        var entry = shadowCanvases.get(canvas);
        if (entry && entry.shadow && isCanvasReadable(entry.shadow)) return entry.shadow;
        // Last resort: the v9 canvas itself (will fail during drawImage, but
        // at least we won't crash here).
        return canvas;
    }

    function stitchCanvases(canvases, mode) {
        // Filter to ready canvases and pull their real pixel sizes.
        var ready = canvases.filter(function (c) {
            return c && c.dataset.mrmReady === '1';
        });
        if (!ready.length) return [];

        // Each entry: { canvas, w, h, natW, natH, originalIndex }
        var items = ready.map(function (c, i) {
            return {
                canvas: c,
                w: c.width,
                h: c.height,
                natW: parseInt(c.dataset.natW || c.width, 10),
                natH: parseInt(c.dataset.natH || c.height, 10),
                originalIndex: parseInt(c.dataset.mrmIdx || i, 10)
            };
        });
        // Sort by original page index so the stitch order matches reading order.
        items.sort(function (a, b) { return a.originalIndex - b.originalIndex; });

        var maxW = 0, maxH = 0;
        items.forEach(function (it) {
            if (it.w > maxW) maxW = it.w;
            if (it.h > maxH) maxH = it.h;
        });

        // Decide how many pages fit per chunk. We accumulate pages until the
        // next one would push the chunk past maxStitchPixels, then start a
        // new chunk. This keeps every output PNG inside the browser's canvas
        // budget.
        var chunks = [];
        var current = null;
        var acc = 0;

        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var incW = mode === 'horizontal' ? it.w : maxW;
            var incH = mode === 'vertical' ? it.h : maxH;

            // Pixels this page would add to the current chunk.
            var addPixels;
            if (mode === 'vertical') {
                addPixels = maxW * it.h;
            } else {
                addPixels = it.w * maxH;
            }

            var currentPixels = current
                ? (current.width * (current.height + (mode === 'vertical' ? it.h : 0))) ||
                  (current.width * current.height)
                : 0;

            // Start a new chunk if this page would overflow the budget.
            if (!current ||
                (mode === 'vertical' && (current.width * (current.cumH + it.h)) > CFG.maxStitchPixels) ||
                (mode === 'horizontal' && ((current.cumW + it.w) * current.height) > CFG.maxStitchPixels)) {
                if (current) chunks.push(current);
                current = {
                    items: [],
                    offsets: [],
                    pageIndices: [],
                    width: mode === 'vertical' ? maxW : 0,
                    height: mode === 'horizontal' ? maxH : 0,
                    cumW: 0,
                    cumH: 0
                };
            }

            current.items.push(it);
            if (mode === 'vertical') {
                current.offsets.push({ x: Math.floor((maxW - it.w) / 2), y: current.cumH });
                current.cumH += it.h;
                current.height = current.cumH;
            } else {
                current.offsets.push({ x: current.cumW, y: Math.floor((maxH - it.h) / 2) });
                current.cumW += it.w;
                current.width = current.cumW;
            }
            current.pageIndices.push(it.originalIndex);
        }
        if (current) chunks.push(current);

        // Render each chunk to its own canvas.
        var rendered = chunks.map(function (chunk, chunkIdx) {
            var cv = document.createElement('canvas');
            cv.width = chunk.width;
            cv.height = chunk.height;
            var ctx = cv.getContext('2d');
            // Draw each page at its offset. drawImage(canvas, dx, dy) draws
            // at the source canvas's own pixel size — no resampling.
            // Use the shadow canvas if the v9 canvas is tainted — it has
            // the same pixels but is readable.
            chunk.items.forEach(function (it, i) {
                var off = chunk.offsets[i];
                try {
                    var drawable = getDrawableCanvas(it.canvas);
                    ctx.drawImage(drawable, off.x, off.y);
                } catch (e) {
                    console.warn('[MRM Extractor] stitch drawImage failed for page', it.originalIndex, e);
                }
            });
            return {
                canvas: cv,
                offsets: chunk.offsets,
                pageIndices: chunk.pageIndices,
                width: chunk.width,
                height: chunk.height,
                chunkIndex: chunkIdx
            };
        });

        return rendered;
    }

    // ------------------------------------------------------------------
    //  ZIP packaging
    // ------------------------------------------------------------------
    async function buildZip(pages, meta) {
        var zip = new JSZip();
        var imgFolder = zip.folder('images');
        var failedPages = [];
        var imageSources = {};
        var writtenStitchedImages = [];
        var outputPages = pages;

        // A stitched image is a real TypeR page, not a collection of source
        // pages pointing at the same file. Move every text box into the
        // stitched image's coordinate space before writing chapter.json.
        var stitchedChunks = [];
        if (stitchMode !== 'separate') {
            stitchedChunks = stitchCanvases(allCanvases(), stitchMode);
        }

        if (stitchedChunks.length) {
            outputPages = [];

            for (var ci = 0; ci < stitchedChunks.length; ci++) {
                var chunk = stitchedChunks[ci];
                var pageName = 'page-' + String(ci + 1).padStart(3, '0') + '.png';

                try {
                    var imgResult = await extractCanvasImage(chunk.canvas);
                    var b64 = await blobToBase64(imgResult.blob);
                    imgFolder.file(pageName, b64, { base64: true });
                    imageSources[pageName] = imgResult.source;
                } catch (e) {
                    console.error('[MRM Extractor] stitched chunk ' + ci + ' failed:', e);
                    failedPages.push({ chunk: ci, error: e.message, pages: chunk.pageIndices });
                    continue;
                }

                var mergedTexts = [];
                var sourcePageIndexes = [];

                for (var pi = 0; pi < chunk.pageIndices.length; pi++) {
                    var pageIndex = chunk.pageIndices[pi];
                    var sourcePage = pages.find(function (p) { return p.index === pageIndex; });
                    var sourceCanvas = allCanvases()[pageIndex];
                    if (!sourcePage || !sourceCanvas) continue;

                    var offset = chunk.offsets[pi];
                    var sourceWidth = Number(sourcePage.width) || sourceCanvas.width;
                    var sourceHeight = Number(sourcePage.height) || sourceCanvas.height;
                    var scaleX = sourceCanvas.width / sourceWidth;
                    var scaleY = sourceCanvas.height / sourceHeight;

                    sourcePageIndexes.push(pageIndex);

                    (sourcePage.texts || []).forEach(function (originalText) {
                        var text = Object.assign({}, originalText);
                        var box = originalText.box || {};
                        text.box = {
                            x: Math.round((Number(box.x) || 0) * scaleX + offset.x),
                            y: Math.round((Number(box.y) || 0) * scaleY + offset.y),
                            w: Math.round((Number(box.w) || 0) * scaleX),
                            h: Math.round((Number(box.h) || 0) * scaleY)
                        };

                        // TypeR derives pixel font size from baseFontSize *
                        // page.width / pageWidth. Rebase those two values so
                        // the font remains the same physical size on the
                        // larger stitched page.
                        var layout = Object.assign({}, originalText.layout || {});
                        var oldPageWidth = Number(layout.pageWidth) || 0;
                        var oldBaseSize = Number(layout.baseFontSize) || 0;
                        if (oldPageWidth > 0 && oldBaseSize > 0 && sourceWidth > 0) {
                            layout.baseFontSize = oldBaseSize * sourceWidth / oldPageWidth * scaleX;
                            layout.pageWidth = chunk.width;
                        }
                        text.layout = layout;

                        if (text.computed && Number.isFinite(Number(text.computed.fontSize))) {
                            text.computed = Object.assign({}, text.computed, {
                                fontSize: Number(text.computed.fontSize) * scaleX
                            });
                        }
                        mergedTexts.push(text);
                    });
                }

                // The manifest now has one ordinary page entry per stitched
                // PNG. No stitchedOffset or second-pass coordinate handling
                // is required by TypeR.
                outputPages.push({
                    index: outputPages.length,
                    sourceFilename: sourcePageIndexes.map(function (index) {
                        var p = pages.find(function (item) { return item.index === index; });
                        return p ? p.sourceFilename : '';
                    }).filter(Boolean).join(', '),
                    imageFilename: pageName,
                    width: chunk.width,
                    height: chunk.height,
                    textCount: mergedTexts.length,
                    texts: mergedTexts,
                    sourcePageIndexes: sourcePageIndexes,
                    imageSource: imageSources[pageName]
                });

                writtenStitchedImages.push({
                    filename: pageName,
                    width: chunk.width,
                    height: chunk.height,
                    pageIndexes: sourcePageIndexes
                });
            }
        } else {
            // Original, unstitched export: one image and one manifest page
            // per source page.
            for (var i = 0; i < pages.length; i++) {
                var p = pages[i];
                var canvas = allCanvases()[p.index];
                if (!canvas || canvas.dataset.mrmReady !== '1') continue;
                try {
                    var result = await extractCanvasImage(canvas);
                    var pageB64 = await blobToBase64(result.blob);
                    imgFolder.file(p.imageFilename, pageB64, { base64: true });
                    p.imageSource = result.source;
                } catch (e) {
                    console.error('[MRM Extractor] page ' + (p.index + 1) + ' failed:', e);
                    failedPages.push({ page: p.index, error: e.message });
                    p.imageFailed = true;
                }
            }
        }

        var translatedCount = 0;
        var totalTexts = 0;
        outputPages.forEach(function (p) {
            (p.texts || []).forEach(function (t) {
                totalTexts++;
                if (t.isTranslated) translatedCount++;
            });
        });

        var manifest = {
            schema: 'manhuarmtl-v1',
            title: meta.title,
            mangaSlug: meta.mangaSlug,
            chapterSlug: meta.chapterSlug,
            url: location.href,
            extractedAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
            pageCount: outputPages.length,
            targetLang: targetLang,
            displayField: primaryFieldFor(targetLang),
            translation: {
                sourceLang: 'en',
                active: translatedCount > 0,
                translatedTexts: translatedCount,
                totalTexts: totalTexts,
                insufficient: targetLang === 'ar' && translatedCount < Math.ceil(totalTexts / 2)
            },
            stitchMode: stitchMode,
            stitchedImages: writtenStitchedImages,
            failedPages: failedPages,
            pages: outputPages
        };
        zip.file('chapter.json', JSON.stringify(manifest, null, 2));

        // TypeR reads the manifest's page/text structure. Keep the plain-text
        // companion in exactly the same page grouping and reading order.
        var lines = [];
        lines.push('# ' + meta.title);
        lines.push('# Source: ' + location.href);
        lines.push('# Extracted: ' + new Date().toISOString());
        lines.push('# Output language: ' +
            (targetLang === 'en' ? 'English (source)' :
             targetLang === 'ar' ? 'Arabic (translated)' : 'Bilingual EN|AR'));
        if (targetLang === 'ar' && translatedCount === 0) {
            lines.push('# WARNING: no Arabic text was captured. Enable Chrome "Translate to Arabic"');
            lines.push('#          on the chapter page, wait for the overlays to flip, then re-extract.');
        }
        lines.push('');
        outputPages.forEach(function (p, pageAt) {
            lines.push('=== Page ' + (pageAt + 1) + ' ===');
            (p.texts || []).forEach(function (t, i) {
                var tag = t.kind ? ('[' + t.kind + ']') : '[text]';
                lines.push((i + 1) + '. ' + tag + ' ' + (t.displayText || t.sourceText || ''));
            });
            lines.push('');
        });
        zip.file('script.txt', lines.join('\n'));

        // Bilingual side-by-side proofreading reference.
        {
            var bi = [];
            bi.push('# ' + meta.title + ' (bilingual reference)');
            bi.push('# source | translated');
            bi.push('');
            outputPages.forEach(function (p, pageAt) {
                bi.push('=== Page ' + (pageAt + 1) + ' ===');
                (p.texts || []).forEach(function (t, i) {
                    bi.push((i + 1) + '. EN: ' + (t.sourceText || ''));
                    bi.push('   AR: ' + (t.isTranslated ? t.text : '(untranslated)'));
                });
                bi.push('');
            });
            zip.file('script-bilingual.txt', bi.join('\n'));
        }

        var cssLines = [];
        cssLines.push('/* Auto-generated from ' + meta.title + ' */');
        outputPages.forEach(function (p, pageAt) {
            (p.texts || []).forEach(function (t, i) {
                if (!t.computed) return;
                var sel = '.page-' + (pageAt + 1) + '-text-' + (i + 1);
                cssLines.push(sel + ' {');
                cssLines.push('  font-family: ' + t.computed.fontFamily + ';');
                cssLines.push('  font-size: ' + ((t.layout && t.layout.baseFontSize) || t.computed.fontSize) + 'px;');
                cssLines.push('  font-weight: ' + t.computed.fontWeight + ';');
                cssLines.push('  font-style: ' + t.computed.fontStyle + ';');
                if (t.computed.textTransform && t.computed.textTransform !== 'none')
                    cssLines.push('  text-transform: ' + t.computed.textTransform + ';');
                if (t.color && t.color.fill) cssLines.push('  color: ' + t.color.fill + ';');
                if (t.stroke) cssLines.push('  -webkit-text-stroke: ' + t.stroke.size + 'px ' + t.stroke.color + ';');
                if (t.dir === 'rtl') {
                    cssLines.push('  direction: rtl;');
                    cssLines.push('  unicode-bidi: embed;');
                }
                cssLines.push('}');
            });
        });
        zip.file('styles.css', cssLines.join('\n'));

        zip.file('README.txt', [
            meta.title,
            '================',
            '',
            'Extracted from: ' + location.href,
            'Pages: ' + outputPages.length,
            '',
            'Files:',
            '  images/page-NNN.png   - exported chapter pages (stitched when selected)',
            '  chapter.json           - full manifest with final text-box coordinates',
            '  script.txt             - plain-text translation grouped by exported page',
            '  styles.css             - CSS rules matching the source lettering',
            '',
            'Import into TypeR Studio:',
            '  1. Open the ZIP/CBZ as a chapter; TypeR reads the images and chapter.json.',
            '  2. Text boxes are already expressed in each exported image coordinate space.',
            '',
            'Standalone viewer:',
            '  Open mtl-reference-viewer.html and drop the ZIP onto it.',
            ''
        ].join('\n'));

        return zip;
    }

    // ------------------------------------------------------------------
    //  UI
    // ------------------------------------------------------------------
    var ui = {
        button: null,
        status: null,
        progress: null
    };

    function setStatus(text, color) {
        if (!ui.status) return;
        ui.status.textContent = text;
        ui.status.style.background = color || '#2c3e50';
    }

    function setProgress(current, total) {
        if (!ui.progress) return;
        ui.progress.style.display = total ? 'block' : 'none';
        if (total) {
            var pct = Math.round((current / total) * 100);
            ui.progress.style.width = pct + '%';
            ui.progress.textContent = current + ' / ' + total;
        }
    }

    function buildUI() {
        var root = document.createElement('div');
        root.id = 'mrm-extractor-ui';
        root.style.cssText = [
            'position: fixed',
            'top: 80px',
            'right: 16px',
            'z-index: 2147483647',
            'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            'display: flex',
            'flex-direction: column',
            'gap: 8px',
            'align-items: flex-end',
            'pointer-events: none'
        ].join(';');

        var btn = document.createElement('button');
        btn.textContent = '\u2B07 Extract Chapter';
        btn.style.cssText = [
            'pointer-events: auto',
            'background: #9b59b6',
            'color: #fff',
            'border: none',
            'padding: 10px 18px',
            'border-radius: 8px',
            'cursor: pointer',
            'font-weight: 700',
            'font-size: 14px',
            'box-shadow: 0 4px 12px rgba(0,0,0,0.3)',
            'transition: background .15s ease'
        ].join(';');
        btn.addEventListener('mouseenter', function () { btn.style.background = '#8e44ad'; });
        btn.addEventListener('mouseleave', function () { btn.style.background = '#9b59b6'; });
        btn.addEventListener('click', onExtractClick);
        ui.button = btn;

        var status = document.createElement('div');
        status.style.cssText = [
            'pointer-events: auto',
            'background: #2c3e50',
            'color: #ecf0f1',
            'padding: 6px 10px',
            'border-radius: 6px',
            'font-size: 12px',
            'max-width: 260px',
            'text-align: right',
            'display: none'
        ].join(';');
        ui.status = status;

        var progressWrap = document.createElement('div');
        progressWrap.style.cssText = [
            'pointer-events: auto',
            'width: 200px',
            'height: 18px',
            'background: #34495e',
            'border-radius: 4px',
            'overflow: hidden',
            'display: none'
        ].join(';');

        var progress = document.createElement('div');
        progress.style.cssText = [
            'width: 0%',
            'height: 100%',
            'background: #3498db',
            'color: #fff',
            'font-size: 11px',
            'text-align: center',
            'line-height: 18px',
            'transition: width .15s ease'
        ].join(';');
        ui.progress = progress;
        progressWrap.appendChild(progress);

        // --- Language selector ---
        // Lets the user explicitly choose what goes into the ZIP and what
        // TypeR Studio / the viewer will display. Without this the importer
        // would silently pick whatever was in t.text, which depends on
        // whether Chrome's translator happened to be active.
        var langRow = document.createElement('div');
        langRow.style.cssText = [
            'pointer-events: auto',
            'display: flex',
            'align-items: center',
            'gap: 6px',
            'background: #2c3e50',
            'color: #ecf0f1',
            'padding: 5px 8px',
            'border-radius: 6px',
            'font-size: 12px'
        ].join(';');

        var langLabel = document.createElement('span');
        langLabel.textContent = 'Output:';
        langLabel.style.fontWeight = '600';
        langRow.appendChild(langLabel);

        var langSelect = document.createElement('select');
        langSelect.style.cssText = [
            'background: #34495e',
            'color: #ecf0f1',
            'border: 1px solid #4a627a',
            'border-radius: 4px',
            'padding: 3px 6px',
            'font-size: 12px',
            'cursor: pointer'
        ].join(';');
        [
            { v: 'en', label: 'English (source)' },
            { v: 'ar', label: 'العربية (translated)' },
            { v: 'bi', label: 'Bilingual EN|AR' }
        ].forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt.v;
            o.textContent = opt.label;
            if (opt.v === targetLang) o.selected = true;
            langSelect.appendChild(o);
        });
        langSelect.addEventListener('change', function () {
            targetLang = langSelect.value;
            setTargetLang(targetLang);
            refreshStatus();
        });
        langRow.appendChild(langSelect);
        ui.langSelect = langSelect;

        // --- Stitch mode selector ---
        // separate  = one PNG per page (default)
        // vertical  = stack all pages into one tall PNG
        // horizontal= lay pages side-by-side into one wide PNG
        //
        // Stitching is lossless (PNG, drawImage copies pixels verbatim). Box
        // positions are preserved via stitchedOffset in the manifest. If the
        // chapter exceeds the browser's canvas budget we automatically split
        // into multiple stitched PNGs.
        var stitchRow = document.createElement('div');
        stitchRow.style.cssText = [
            'pointer-events: auto',
            'display: flex',
            'align-items: center',
            'gap: 6px',
            'background: #2c3e50',
            'color: #ecf0f1',
            'padding: 5px 8px',
            'border-radius: 6px',
            'font-size: 12px'
        ].join(';');

        var stitchLabel = document.createElement('span');
        stitchLabel.textContent = 'Layout:';
        stitchLabel.style.fontWeight = '600';
        stitchRow.appendChild(stitchLabel);

        var stitchSelect = document.createElement('select');
        stitchSelect.style.cssText = langSelect.style.cssText;
        [
            { v: 'separate', label: 'Separate (N PNGs)' },
            { v: 'vertical', label: 'Vertical stitch (1 tall)' },
            { v: 'horizontal', label: 'Horizontal stitch (1 wide)' }
        ].forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt.v;
            o.textContent = opt.label;
            if (opt.v === stitchMode) o.selected = true;
            stitchSelect.appendChild(o);
        });
        stitchSelect.addEventListener('change', function () {
            stitchMode = stitchSelect.value;
            setStitchMode(stitchMode);
            refreshStatus();
        });
        stitchRow.appendChild(stitchSelect);
        ui.stitchSelect = stitchSelect;

        root.appendChild(btn);
        root.appendChild(langRow);
        root.appendChild(stitchRow);
        root.appendChild(status);
        root.appendChild(progressWrap);
        document.body.appendChild(root);

        refreshStatus();
        setInterval(refreshStatus, 1500);
    }

    function refreshStatus() {
        var all = allCanvases();
        var ready = readyCanvases();
        if (!all.length) {
            ui.status.style.display = 'none';
            return;
        }
        ui.status.style.display = 'block';

        // Detect whether a browser translator has rewritten any overlay text.
        // This lets the user know whether they will get Arabic or English.
        var translated = 0, sampled = 0;
        document.querySelectorAll('.manga-ocr-button-overlay').forEach(function (ov) {
            var src = ov.dataset.text || '';
            var span = ov.querySelector('span');
            var disp = span ? span.textContent.trim() : '';
            if (src && disp) {
                sampled++;
                if (disp !== src) translated++;
            }
        });

        var msg;
        var color;
        if (ready.length === all.length) {
            msg = ready.length + ' / ' + all.length + ' pages ready';
            color = '#27ae60';
            ui.button.disabled = false;
            ui.button.style.opacity = '1';
        } else {
            msg = 'Loading pages: ' + ready.length + ' / ' + all.length;
            color = '#e67e22';
        }

        if (sampled > 0) {
            if (translated > 0) {
                msg += '  |  AR: ' + translated + '/' + sampled + ' texts';
                color = '#2980b9';
            } else {
                msg += '  |  EN only';
            }
        }

        // Warn the user if they picked Arabic but the browser translator
        // has not actually run — otherwise they would silently get English.
        if (targetLang === 'ar' && sampled > 0 && translated === 0) {
            msg = '\u26A0 AR selected but no translation detected. Enable Chrome "Translate to Arabic".';
            color = '#c0392b';
        } else if (targetLang === 'ar' && translated > 0 && translated < sampled) {
            msg += '  \u26A0 ' + (sampled - translated) + ' untranslated';
        }

        setStatus(msg, color);
    }

    // ------------------------------------------------------------------
    //  Main flow
    // ------------------------------------------------------------------
    var extracting = false;

    async function onExtractClick() {
        if (extracting) return;
        if (!isChapterPage()) {
            alert('This does not look like a chapter page.');
            return;
        }
        var canvases = allCanvases();
        if (!canvases.length) {
            alert('No chapter pages found on this page.');
            return;
        }

        extracting = true;
        ui.button.disabled = true;
        ui.button.textContent = '\u23F3 Working...';

        try {
            // Wait until every canvas is drawn, or until the timeout.
            var waited = 0;
            while (!isEverythingReady() && waited < CFG.readyTimeoutMs) {
                setStatus('Waiting for pages: ' + readyCanvases().length + ' / ' + canvases.length, '#e67e22');
                // Nudge the page by scrolling to the bottom so the Intersection
                // Observer promotes every canvas.
                if (waited % 5000 === 0 && waited > 0) {
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
                    setTimeout(function () {
                        window.scrollTo({ top: 0, behavior: 'instant' });
                    }, 200);
                }
                await new Promise(function (r) { setTimeout(r, CFG.pollIntervalMs); });
                waited += CFG.pollIntervalMs;
            }

            if (!isEverythingReady()) {
                var ok = confirm(
                    'Only ' + readyCanvases().length + ' of ' + canvases.length +
                    ' pages are ready. Extract what we have?'
                );
                if (!ok) {
                    extracting = false;
                    ui.button.disabled = false;
                    ui.button.textContent = '\u2B07 Extract Chapter';
                    return;
                }
            }

            // Extract metadata for each ready page.
            var pages = [];
            for (var i = 0; i < canvases.length; i++) {
                if (canvases[i].dataset.mrmReady !== '1') continue;
                setStatus('Reading page ' + (i + 1) + ' / ' + canvases.length, '#2980b9');
                setProgress(i + 1, canvases.length);
                pages.push(extractPage(canvases[i], i));
                await new Promise(function (r) { setTimeout(r, CFG.yieldMs); });
            }

            // Build the ZIP.  buildZip now handles per-page failures
            // internally (via extractCanvasImage's shadow-canvas fallback)
            // and records any that still fail in manifest.failedPages, so
            // a single tainted page no longer kills the whole chapter.
            setStatus('Packaging ZIP...', '#8e44ad');
            setProgress(0, 0);
            var meta = {
                title: getChapterTitle(),
                mangaSlug: getMangaSlug(),
                chapterSlug: getChapterSlug()
            };
            var zip = await buildZip(pages, meta);

            // Count how many pages actually have an image in the ZIP.
            var okCount = pages.filter(function (p) { return !p.imageFailed; }).length;
            var failCount = pages.length - okCount;

            setStatus('Compressing...', '#8e44ad');
            var blob = await zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 }
            });

            // Trigger download.
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = meta.chapterSlug + '.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 4000);

            if (failCount > 0) {
                var msg = 'Done with ' + okCount + ' / ' + pages.length + ' pages.\n\n' +
                          failCount + ' page(s) could not be extracted (canvas tainted or blocked).\n' +
                          'The failed pages are listed in chapter.json under "failedPages".\n\n' +
                          'Tip: disable any privacy extension (CanvasBlocker, Brave Shields) for this site,\n' +
                          'or try a different browser (Chrome without strict fingerprinting protection).';
                setStatus('Done: ' + okCount + '/' + pages.length + ' pages (' + failCount + ' failed)', '#e67e22');
                setProgress(pages.length, pages.length);
                setTimeout(function () { alert(msg); }, 500);
            } else {
                setStatus('Done! ' + pages.length + ' pages exported.', '#27ae60');
                setProgress(pages.length, pages.length);
            }
        } catch (err) {
            console.error('[MRM Extractor] failed:', err);
            setStatus('Error: ' + (err && err.message ? err.message : err), '#c0392b');
            // Don't scare the user with a raw alert — show a helpful message.
            var hint = '';
            if (/tainted|toBlob|null/i.test(err.message || '')) {
                hint = '\n\nThis usually means the browser is blocking canvas readback.\n' +
                       'Try: disable privacy extensions for this site, or use regular Chrome.';
            }
            alert('Extraction failed:\n' + (err && err.message ? err.message : err) + hint);
        } finally {
            extracting = false;
            ui.button.disabled = false;
            ui.button.textContent = '\u2B07 Extract Chapter';
            setTimeout(function () { setProgress(0, 0); }, 2000);
        }
    }

    // ------------------------------------------------------------------
    //  Init
    // ------------------------------------------------------------------
    function init() {
        if (!isChapterPage()) return;
        if (document.getElementById('mrm-extractor-ui')) return;

        // Wait for the body to exist.
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', init, { once: true });
            return;
        }

        // Defer until the reading content has at least one canvas, but show the
        // button right away so the user knows the script is active.
        buildUI();

        // Also hook into the keyboard shortcut: Ctrl+Shift+E
        document.addEventListener('keydown', function (e) {
            if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
                e.preventDefault();
                onExtractClick();
            }
        });
    }

    // Try to start as soon as possible; the button will refresh its status on
    // its own once canvases appear.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();