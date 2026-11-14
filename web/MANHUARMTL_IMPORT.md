# ManhuaRMTL chapter import

The TypeR Studio web build includes `mrm-import.js` from `index.html`.

## Importing a chapter

1. Install the companion ManhuaRMTL extractor userscript in Tampermonkey/Violentmonkey.
2. Open a ManhuaRMTL chapter and use **Extract Chapter** to download its ZIP.
3. Open TypeR Studio and drop the generated `chapter-*.zip` onto the workspace.
4. The importer reads `chapter.json`, extracts the PNGs, and hands the page files to TypeR's native `TypeRApp.openChapter()` pipeline.
5. Use TypeR's page navigator to move through separate-page exports. For stitched exports, the importer groups all source-page reference boxes that belong to the currently opened stitched image.

## Compatibility details

- Uses TypeR's native chapter/file-opening API instead of synthetic drag/drop events.
- Resolves the active chapter image from TypeR's chapter state and active tab.
- Uses TypeR's `toScreen()` transform so reference rectangles follow zoom and pan.
- Accounts for stitched offsets and per-page source-to-canvas scaling.
- Missing ZIP images are reported without preventing the remaining pages from opening.

The companion extractor userscript is provided as a separate installable file with this repair; it is not loaded by the TypeR Studio web page.