/*
 * ManhuaRMTL chapter importer for TypeR Studio.
 * Uses TypeRApp.openChapter() and TypeRApp's document-coordinate transforms.
 */
(function () {
  "use strict";
  if (window.__mrmImportInstalled) return;
  window.__mrmImportInstalled = true;

  const state = { manifest: null, activeFile: null, overlays: [], observer: null };
  let panel = null, panelBody = null, overlayLayer = null, refreshTimer = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const app = () => window.TypeRApp;
  const isZip = (file) => file && (/\.zip$/i.test(file.name) || file.type === "application/zip");

  function ensureJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      script.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error("JSZip did not initialize"));
      script.onerror = () => reject(new Error("Could not load JSZip"));
      document.head.appendChild(script);
    });
  }

  function pageFiles(manifest) {
    const seen = new Set();
    return (manifest.pages || []).filter(page => {
      if (!page || !page.imageFilename || page.imageFailed || seen.has(page.imageFilename)) return false;
      seen.add(page.imageFilename);
      return true;
    }).map(page => page.imageFilename);
  }

  async function loadZip(file) {
    const JSZip = await ensureJSZip();
    const zip = await JSZip.loadAsync(file);
    const manifestEntry = zip.file("chapter.json");
    if (!manifestEntry) throw new Error("chapter.json is missing; this is not a ManhuaRMTL chapter archive.");
    const manifest = JSON.parse(await manifestEntry.async("string"));
    if (!manifest || manifest.schema !== "manhuarmtl-v1" || !Array.isArray(manifest.pages) || !manifest.pages.length) {
      throw new Error("The chapter manifest is invalid or contains no pages.");
    }

    const files = [];
    const missing = [];
    for (const filename of pageFiles(manifest)) {
      const entry = zip.file("images/" + filename);
      if (!entry) { missing.push(filename); continue; }
      const blob = await entry.async("blob");
      files.push(new File([blob], filename, { type: "image/png", lastModified: Date.now() }));
    }
    if (!files.length) throw new Error("No usable page images were found in images/.");

    const typer = app();
    if (!typer || typeof typer.openChapter !== "function") {
      throw new Error("This TypeR Studio build does not expose TypeRApp.openChapter(). Update TypeR Studio or use the matching fork.");
    }

    state.manifest = manifest;
    state.activeFile = null;
    buildPanel();
    buildOverlayLayer();

    // TypeR's native chapter importer handles natural sorting, page navigation,
    // tab/document creation and the correct internal file pipeline.
    await typer.openChapter(files);
    syncActivePage();
    if (missing.length) {
      console.warn("[MRM Import] Missing image entries:", missing);
      showNotice(missing.length + " image file(s) were missing from the ZIP; available pages were opened.");
    }
    console.info("[MRM Import] Imported", files.length, "TypeR page document(s) from", manifest.title || file.name);
  }

  function installDropHandler() {
    window.addEventListener("dragover", event => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files")) event.preventDefault();
    });
    window.addEventListener("drop", event => {
      const files = Array.from(event.dataTransfer && event.dataTransfer.files || []);
      const zip = files.find(file => isZip(file) && /chapter|manhuarmtl/i.test(file.name));
      if (!zip) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      loadZip(zip).catch(error => {
        console.error("[MRM Import] Import failed:", error);
        alert("Could not import chapter: " + (error.message || error));
      });
    }, true);
  }

  function buildPanel() {
    if (panel) { panel.style.display = "flex"; return; }
    panel = document.createElement("section");
    panel.id = "mrm-reference-panel";
    panel.style.cssText = "position:fixed;top:100px;right:16px;width:310px;max-height:65vh;background:#26202e;color:#ece6f0;border:1px solid #43374f;border-radius:10px;box-shadow:0 8px 24px #0006;z-index:2147483000;font:13px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;overflow:hidden";
    const header = document.createElement("header");
    header.style.cssText = "padding:10px 12px;background:#322a3d;border-bottom:1px solid #43374f;font-weight:700;display:flex;justify-content:space-between;cursor:move";
    const title = document.createElement("span");
    title.textContent = "MTL Reference";
    const close = document.createElement("button");
    close.type = "button"; close.textContent = "×";
    close.style.cssText = "border:0;background:none;color:inherit;font-size:20px;cursor:pointer";
    close.addEventListener("click", () => { panel.style.display = "none"; clearOverlays(); });
    header.append(title, close);
    panelBody = document.createElement("div");
    panelBody.id = "mrm-panel-body";
    panelBody.style.cssText = "padding:8px;overflow:auto;flex:1";
    panel.append(header, panelBody);
    document.body.appendChild(panel);
    makeDraggable(panel, header);
  }

  function makeDraggable(element, handle) {
    handle.addEventListener("pointerdown", event => {
      if (event.target.closest("button")) return;
      const rect = element.getBoundingClientRect();
      const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      const move = e => {
        element.style.left = (e.clientX - dx) + "px";
        element.style.top = (e.clientY - dy) + "px";
        element.style.right = "auto";
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    });
  }

  function buildOverlayLayer() {
    if (overlayLayer) return;
    overlayLayer = document.createElement("div");
    overlayLayer.id = "mrm-overlay-layer";
    overlayLayer.style.cssText = "position:fixed;pointer-events:none;z-index:1000;overflow:hidden";
    document.body.appendChild(overlayLayer);
  }

  function currentImageName() {
    const typer = app();
    const chapter = typer && typeof typer.chapter === "function" ? typer.chapter() : null;
    if (chapter && chapter.at >= 0 && chapter.pages && chapter.pages[chapter.at]) {
      return chapter.pages[chapter.at].name;
    }
    const activeTab = $(".tab.is-on");
    if (activeTab) return activeTab.title || $("span", activeTab)?.textContent || "";
    return "";
  }

  function syncActivePage() {
    if (!state.manifest) return;
    const name = currentImageName();
    if (!name) { clearOverlays(); return; }
    state.activeFile = name;
    const pages = state.manifest.pages.filter(page => page.imageFilename === name);
    renderPanel(pages);
    drawOverlays(pages);
  }

  function sourceToDocument(page, box) {
    const stitched = page.stitchedOffset && Number.isFinite(page.stitchedOffset.x) && Number.isFinite(page.stitchedOffset.y);
    const scaleX = (page.canvasWidth || page.width || 1) / (page.width || 1);
    const scaleY = (page.canvasHeight || page.height || 1) / (page.height || 1);
    return {
      x: (box.x || 0) * scaleX + (stitched ? page.stitchedOffset.x : 0),
      y: (box.y || 0) * scaleY + (stitched ? page.stitchedOffset.y : 0),
      w: (box.w || 0) * scaleX,
      h: (box.h || 0) * scaleY
    };
  }

  function drawOverlays(pages) {
    clearOverlays();
    if (!pages || !pages.length || !panel || panel.style.display === "none") return;
    const typer = app();
    const stage = $("#stage");
    if (!typer || typeof typer.toScreen !== "function" || !stage) return;
    const rect = stage.getBoundingClientRect();
    overlayLayer.style.left = rect.left + "px";
    overlayLayer.style.top = rect.top + "px";
    overlayLayer.style.width = rect.width + "px";
    overlayLayer.style.height = rect.height + "px";

    pages.forEach(page => (page.texts || []).forEach((text, index) => {
      if (!text.box) return;
      const docBox = sourceToDocument(page, text.box);
      const [x, y] = typer.toScreen(docBox.x, docBox.y);
      const [right, bottom] = typer.toScreen(docBox.x + docBox.w, docBox.y + docBox.h);
      const box = document.createElement("button");
      box.type = "button";
      box.title = displayText(text);
      box.setAttribute("aria-label", "Reference text " + (index + 1));
      box.style.cssText = "position:absolute;left:" + x + "px;top:" + y + "px;width:" + Math.max(1, right - x) + "px;height:" + Math.max(1, bottom - y) + "px;padding:0;border:1.5px solid rgba(155,89,182,.85);background:rgba(155,89,182,.12);border-radius:3px;cursor:pointer;pointer-events:auto;box-sizing:border-box";
      box.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        copyText(copyValue(text));
        highlight(index);
      });
      overlayLayer.appendChild(box);
      state.overlays.push(box);
    }));
  }

  function displayText(text) {
    if (text.displayText != null) return text.displayText;
    const lang = state.manifest && state.manifest.targetLang || "en";
    if (lang === "ar") return text.text || text.sourceText || "";
    if (lang === "bi") return text.isTranslated && text.text ? "EN: " + (text.sourceText || "") + " | AR: " + text.text : (text.sourceText || "") + " [untranslated]";
    return text.sourceText || text.text || "";
  }
  function copyValue(text) {
    const lang = state.manifest && state.manifest.targetLang || "en";
    if (lang === "ar") return text.text || text.sourceText || "";
    if (lang === "bi") return text.isTranslated && text.text ? text.text : (text.sourceText || "");
    return text.sourceText || text.text || "";
  }

  function renderPanel(pages) {
    if (!panelBody) return;
    panelBody.replaceChildren();
    const lang = state.manifest.targetLang || "en";
    if (lang === "ar" && state.manifest.translation && state.manifest.translation.insufficient) {
      const warning = document.createElement("div");
      warning.textContent = "تنبيه: بعض النصوص قد لا تكون مترجمة إلى العربية.";
      warning.style.cssText = "padding:7px;background:#8e3030;border-radius:5px;margin-bottom:8px";
      panelBody.appendChild(warning);
    }
    if (!pages.length) {
      const empty = document.createElement("p"); empty.textContent = "No reference data for this image."; panelBody.appendChild(empty); return;
    }
    pages.forEach(page => {
      const heading = document.createElement("div");
      heading.textContent = "Page " + ((page.index || 0) + 1) + " · " + ((page.texts || []).length) + " texts";
      heading.style.cssText = "font-size:11px;color:#b9a9c8;margin:5px 0 8px;text-transform:uppercase";
      panelBody.appendChild(heading);
      (page.texts || []).forEach((text, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.dataset.idx = index;
        item.style.cssText = "display:block;width:100%;text-align:start;background:#322a3d;color:#ece6f0;border:1px solid #43374f;border-radius:6px;padding:8px;margin:0 0 6px;cursor:pointer";
        const meta = document.createElement("small");
        meta.style.cssText = "display:block;color:#b9a9c8;margin-bottom:3px";
        meta.textContent = "#" + (index + 1) + (text.kind ? " · " + text.kind : "");
        const content = document.createElement("span");
        content.textContent = displayText(text);
        if (text.dir === "rtl") { content.dir = "rtl"; content.style.display = "block"; }
        item.append(meta, content);
        item.addEventListener("click", () => { copyText(copyValue(text)); highlight(index); });
        panelBody.appendChild(item);
      });
    });
  }

  function highlight(index) {
    state.overlays.forEach((box, i) => {
      box.style.borderColor = i === index ? "#27ae60" : "rgba(155,89,182,.85)";
      box.style.background = i === index ? "rgba(39,174,96,.25)" : "rgba(155,89,182,.12)";
    });
  }

  function copyText(value) {
    const text = String(value || "");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const input = document.createElement("textarea");
    input.value = text; input.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(input); input.select();
    try { document.execCommand("copy"); } catch (_) {}
    input.remove();
  }
  function showNotice(message) {
    const notice = document.createElement("div");
    notice.textContent = message;
    notice.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#8e3030;color:white;padding:10px 14px;border-radius:7px;z-index:2147483647";
    document.body.appendChild(notice);
    setTimeout(() => notice.remove(), 5000);
  }
  function clearOverlays() {
    if (overlayLayer) overlayLayer.replaceChildren();
    state.overlays = [];
  }
  function refresh() {
    if (!state.manifest) return;
    const name = currentImageName();
    if (name !== state.activeFile) syncActivePage();
    else {
      const pages = state.manifest.pages.filter(page => page.imageFilename === state.activeFile);
      drawOverlays(pages);
    }
  }

  function observeWorkspace() {
    const tabs = $("#tabs");
    if (tabs) {
      state.observer = new MutationObserver(() => syncActivePage());
      state.observer.observe(tabs, { subtree: true, attributes: true, attributeFilter: ["class", "title"], childList: true });
    }
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    document.addEventListener("wheel", refresh, true);
    document.addEventListener("pointerup", refresh, true);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 350);
  }

  installDropHandler();
  observeWorkspace();
})();