// A chapter that comes as one archive: a .cbz, or a .zip holding its pages (in the root or in
// a folder such as images/). The pages are read out of it and open like the files of a folder
// (see openChapter in app.js). When the archive also holds the chapter's text, in a
// chapter.json (its "pages" with their "texts") or a script.txt ("=== Page N ===" blocks), that
// text becomes a TypeR script: "Page N" markers, one line per text. The chapter.json's boxes
// (position, size, colours) are given too, per page file, for the app to set as text layers.
// The archive reader is the one of kit.js; nothing leaves this browser.

(function () {
  "use strict";

  const ARCHIVE = /\.(cbz|zip)$/i;
  const PAGE = /\.(psd|psb|png|jpe?g|webp)$/i;
  // Hidden files and what macOS adds to an archive aren't pages
  const JUNK = /(^|\/)(\.|__MACOSX(\/|$))/;
  const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", psd: "image/vnd.adobe.photoshop", psb: "image/vnd.adobe.photoshop" };
  const ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const MAX_TEXT = 32 * 1024 * 1024;

  const slashes = (name) => name.replace(/\\/g, "/");
  const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

  // The names the pages get: the folders they sit in don't count, unless two pages would then
  // share a name (ch1/01.png, ch2/01.png): the folder then goes in front, as "ch1 - 01.png".
  const namesOf = (paths) => {
    const bases = paths.map(baseName);
    if (new Set(bases.map((name) => name.toLowerCase())).size === bases.length) return bases;
    const parts = paths.map((path) => path.split("/"));
    let shared = 0;
    while (parts.every((list) => list.length > shared + 1 && list[shared] === parts[0][shared])) shared++;
    return parts.map((list) => list.slice(shared).join(" - "));
  };

  const oneLine = (text) => String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(/\s*\n\s*/g, " ").trim();

  // A TypeR script from chapter.json: { title, pages: [{ texts: [{ text }] }] }, the texts of a
  // page already in reading order. Pages with no text get no marker. Null when it holds no text.
  const scriptOfManifest = (manifest) => {
    if (!manifest || !Array.isArray(manifest.pages)) return null;
    const out = [];
    let any = false;
    manifest.pages.forEach((page, at) => {
      const lines = (Array.isArray(page && page.texts) ? page.texts : []).map((one) => oneLine(one && one.text)).filter(Boolean);
      if (!lines.length) return;
      any = true;
      out.push(`Page ${at + 1}`, ...lines);
    });
    return any ? out.join("\n") : null;
  };

  const hex = /^#([0-9a-f]{6})$/i;
  const rgbOf = (value) => {
    const found = hex.exec(String(value || "").trim());
    if (!found) return null;
    const n = parseInt(found[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };

  // The text boxes of chapter.json, by the name of the page file that holds them:
  // { width, height, texts: [{ text, left, top, width, height, size, fill, outline }] }, the
  // lengths in pixels of the page's own picture, the colours as { r, g, b } or null.
  // `names` are the page files in the order of the pages; a page is found by its imageFilename,
  // or else by its place. Null when no page has a box with text.
  const boxesOfManifest = (manifest, names) => {
    if (!manifest || !Array.isArray(manifest.pages)) return null;
    const byName = new Map(names.map((name) => [name.toLowerCase(), name]));
    const boxes = {};
    let any = false;
    manifest.pages.forEach((page, at) => {
      if (!page) return;
      const given = typeof page.imageFilename === "string" ? baseName(slashes(page.imageFilename)).toLowerCase() : "";
      const file = byName.get(given) || names[at];
      const width = Number(page.width);
      const height = Number(page.height);
      if (!file || !(width > 0) || !(height > 0)) return;
      const texts = [];
      (Array.isArray(page.texts) ? page.texts : []).forEach((one) => {
        const text = oneLine(one && one.text);
        const box = one && one.box;
        if (!text || !box) return;
        const left = Number(box.x);
        const top = Number(box.y);
        const w = Number(box.w);
        const h = Number(box.h);
        if (![left, top, w, h].every(Number.isFinite) || w < 4 || h < 4) return;
        // The size the text was laid out at, in the page's own pixels (it was laid out at pageWidth)
        const layout = (one && one.layout) || {};
        const laid = Number(layout.baseFontSize) || Number(one.computed && one.computed.fontSize) || 0;
        const across = Number(layout.pageWidth) || 0;
        texts.push({
          text,
          left,
          top,
          width: w,
          height: h,
          size: laid > 0 && across > 0 ? (laid * width) / across : 0,
          fill: rgbOf(one.color && one.color.fill),
          outline: rgbOf(one.color && one.color.outline),
        });
      });
      if (!texts.length) return;
      any = true;
      boxes[file] = { width, height, texts };
    });
    return any ? boxes : null;
  };

  // A TypeR script from script.txt: "=== Page 4 ===" blocks of "1. [kind] text" lines, and "#"
  // header lines. Null when it holds no text.
  const scriptOfText = (text) => {
    const out = [];
    let any = false;
    for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
      const page = /^=+\s*Page\s+(\d+)\s*=+\s*$/i.exec(raw.trim());
      if (page) {
        out.push(`\u0000${page[1]}`);
        continue;
      }
      if (/^#/.test(raw) || !raw.trim()) continue;
      const line = raw.replace(/^\s*\d+\.\s*(\[[^\]]*\]\s?)?/, "").trim();
      if (!line) continue;
      any = true;
      out.push(line);
    }
    if (!any) return null;
    // A marker only for the pages that have lines
    const lines = [];
    let pending = null;
    for (const entry of out) {
      if (entry.charCodeAt(0) === 0) pending = entry.slice(1);
      else {
        if (pending !== null) lines.push(`Page ${pending}`);
        pending = null;
        lines.push(entry);
      }
    }
    return lines.join("\n");
  };

  const textOf = async (zip, entry) => {
    if (entry.size > MAX_TEXT) return null;
    return new TextDecoder().decode(await zip.read(entry));
  };

  // What an archive holds: { files, script, name }. files are the pages as Files, in the order of
  // their names (null when there is none: a style kit is a .zip too); script is the TypeR script
  // of its text, or null; name is the chapter's title when it says one. Throws when the archive
  // can't be read.
  const read = async (file, Kit = window.TypeRKit) => {
    const zip = Kit.zipEntries(await file.arrayBuffer());
    const live = zip.entries.map((entry) => ({ entry, path: slashes(entry.name) })).filter(({ path }) => !JUNK.test(path));
    const found = live.filter(({ path }) => PAGE.test(path)).sort((a, b) => ORDER.compare(a.path, b.path));
    if (!found.length) return { files: null, script: null, name: null, boxes: null };
    const names = namesOf(found.map((item) => item.path));
    const files = [];
    for (let i = 0; i < found.length; i++) {
      const extension = names[i].slice(names[i].lastIndexOf(".") + 1).toLowerCase();
      files.push(new File([await zip.read(found[i].entry)], names[i], { type: TYPES[extension] || "" }));
    }
    // The text: the manifest first, the plain script when it has none. The shallowest file wins.
    const nearest = (pattern) => live.filter(({ path }) => pattern.test(baseName(path))).sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
    let script = null;
    let name = null;
    let boxes = null;
    const manifest = nearest(/^chapter\.json$/i);
    if (manifest) {
      try {
        const data = JSON.parse(await textOf(zip, manifest.entry));
        script = scriptOfManifest(data);
        boxes = boxesOfManifest(data, names);
        if (data && typeof data.title === "string" && data.title.trim()) name = data.title.trim();
      } catch (error) {
        console.warn("chapter.json can't be read", error);
      }
    }
    if (!script) {
      const plain = nearest(/^script\.txt$/i);
      if (plain) script = scriptOfText(await textOf(zip, plain.entry) || "");
    }
    return { files, script, name, boxes };
  };

  // The pages of an archive as Files, or null when it holds none
  const readPages = async (file, Kit = window.TypeRKit) => (await read(file, Kit)).files;

  // The entries given back, the archives among them replaced by their pages. The very same array
  // when there is no archive. `expanded` tells when one was opened: it is a chapter. `script`
  // holds { text, name } when an archive had a text with it, and `boxes` the text boxes by page file.
  // `say` gets the messages the reader should see: (kind, name, error).
  const expand = async (entries, say = () => {}, Kit = window.TypeRKit) => {
    const list = Array.from(entries || []);
    if (!list.some((entry) => ARCHIVE.test((entry.file || entry).name))) return entries;
    const out = [];
    out.expanded = Boolean(entries.expanded);
    out.script = entries.script || null;
    out.boxes = entries.boxes || null;
    for (const entry of list) {
      const file = entry.file || entry;
      if (!ARCHIVE.test(file.name)) {
        out.push(entry);
        continue;
      }
      const comic = /\.cbz$/i.test(file.name);
      let found = null;
      try {
        say("reading", file.name);
        found = await read(file, Kit);
      } catch (error) {
        // A .zip that can't be read may be something else: the style kits get their turn
        if (comic) {
          say("damaged", file.name, error);
          continue;
        }
      }
      if (found && found.files) {
        found.files.forEach((page) => out.push({ file: page, handle: null }));
        out.expanded = true;
        if (found.boxes) out.boxes = Object.assign({}, out.boxes, found.boxes);
        if (found.script && !out.script) out.script = { text: found.script, name: found.name || file.name.replace(/\.(cbz|zip)$/i, "") };
      } else out.push(entry);
    }
    return out;
  };

  window.TypeRChapterArchive = { ARCHIVE, read, readPages, expand, scriptOfManifest, scriptOfText, boxesOfManifest };
})();
