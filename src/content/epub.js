/**
 * EPUB export - packages one article as an EPUB 3 file (plus an EPUB 2 NCX for older readers)
 *
 * No library: the zip is written uncompressed ("stored"). EPUB requires that for the mimetype
 * entry anyway, and the images (re-encoded as JPEG) don't compress further.
 * Loaded before content.js, which calls InkPagesEpub.build().
 */

// eslint-disable-next-line no-unused-vars
var InkPagesEpub = (function() {
  'use strict';

  // Elements kept as they are. Others are unwrapped (content kept), or dropped when in DROP.
  const KEEP = new Set([
    'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col',
    'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
    'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
    'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strong', 'sub',
    'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr'
  ]);
  const DROP = new Set([
    'audio', 'button', 'canvas', 'embed', 'form', 'iframe', 'input', 'link', 'map', 'math', 'meta',
    'noscript', 'object', 'script', 'select', 'source', 'style', 'svg', 'template', 'textarea',
    'track', 'video'
  ]);
  const ATTRIBUTES = {
    '*': ['class', 'dir', 'id', 'lang', 'title'],
    a: ['href'],
    img: ['src', 'alt'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'reversed'],
    col: ['span'],
    colgroup: ['span']
  };
  // Phrasing elements may not contain blocks in XHTML; when they do, they are unwrapped
  const PHRASING = new Set([
    'abbr', 'b', 'cite', 'code', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small',
    'span', 'strong', 'sub', 'sup', 'u', 'var'
  ]);
  const BLOCKS = 'address, article, aside, blockquote, details, div, dl, figure, footer, h1, h2, ' +
    'h3, h4, h5, h6, header, hr, main, ol, p, pre, section, table, ul';

  const MAX_IMAGE_WIDTH = 1600;
  const MAX_IMAGE_HEIGHT = 2400;
  const MIN_IMAGE_SIZE = 40; // smaller images are icons and tracking pixels

  function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[ch]);
  }

  // Characters that are not allowed anywhere in XML
  function stripInvalidXmlChars(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  }

  // crypto.randomUUID() only exists on https pages
  function randomUuid() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function validLanguage(lang) {
    return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(lang || '') ? lang : 'en';
  }

  /**
   * Pick the image URL to fetch: from srcset the smallest candidate at least 1200px wide
   * (else the largest), otherwise src
   */
  function pickImageUrl(img, baseUrl) {
    let url = img.getAttribute('src') || img.getAttribute('data-src') || '';
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcset) {
      const candidates = srcset.split(/,\s+/).map(candidate => {
        const [candidateUrl, descriptor = '1x'] = candidate.trim().split(/\s+/);
        return { url: candidateUrl, size: parseFloat(descriptor) || 1, isWidth: /w$/.test(descriptor) };
      }).filter(candidate => candidate.url);
      if (candidates.length) {
        candidates.sort((a, b) => a.size - b.size);
        const wide = candidates.find(candidate => candidate.isWidth && candidate.size >= 1200);
        url = (wide || candidates[candidates.length - 1]).url;
      }
    }
    try {
      const resolved = new URL(url, baseUrl);
      return ['http:', 'https:', 'data:'].includes(resolved.protocol) ? resolved.href : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch an image and re-encode it as a JPEG, scaled down for e-readers.
   * Returns null for tiny images; throws when the image can't be fetched or decoded.
   */
  async function fetchAsJpeg(url, grayscale) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());

    try {
      if (bitmap.width < MIN_IMAGE_SIZE || bitmap.height < MIN_IMAGE_SIZE) return null;
      const scale = Math.min(1, MAX_IMAGE_WIDTH / bitmap.width, MAX_IMAGE_HEIGHT / bitmap.height);
      const width = Math.round(bitmap.width * scale);
      const height = Math.round(bitmap.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // JPEG has no transparency
      ctx.fillRect(0, 0, width, height);
      if (grayscale) ctx.filter = 'grayscale(100%)';
      ctx.drawImage(bitmap, 0, 0, width, height);

      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      if (!jpeg) throw new Error('JPEG encoding failed');
      return new Uint8Array(await jpeg.arrayBuffer());
    } finally {
      bitmap.close();
    }
  }

  // Remove an image that couldn't be packaged, and its figure when nothing worth keeping is left
  function dropImage(img) {
    const figure = img.closest('figure');
    img.remove();
    if (!figure || figure.querySelector('img')) return;
    figure.querySelectorAll('.inkpages-credit').forEach(credit => credit.remove());
    if (!figure.textContent.trim()) figure.remove();
  }

  /**
   * Fetch every image in root (a few at a time), point it at its packaged file and
   * return the files. Images that fail are dropped from the article.
   */
  async function packImages(root, baseUrl, grayscale) {
    const images = Array.from(root.querySelectorAll('img'));
    const results = new Array(images.length).fill(null);
    let next = 0;
    let skipped = 0;

    async function worker() {
      while (next < images.length) {
        const index = next++;
        const url = pickImageUrl(images[index], baseUrl);
        try {
          results[index] = url ? await fetchAsJpeg(url, grayscale) : null;
          if (!url) skipped++;
        } catch (e) {
          console.warn('InkPages: image left out of EPUB', url, e);
          skipped++;
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);

    const files = [];
    images.forEach((img, index) => {
      if (!results[index]) {
        dropImage(img);
        return;
      }
      const name = `images/img${String(files.length + 1).padStart(3, '0')}.jpg`;
      files.push({ name, data: results[index] });
      img.setAttribute('src', name);
      if (!img.hasAttribute('alt')) img.setAttribute('alt', '');
    });
    return { files, skipped };
  }

  /**
   * Make the article valid XHTML for EPUB: allowed elements and attributes only, absolute
   * links, unique ids, no invalid characters
   */
  function cleanForXhtml(root, baseUrl) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(comment => comment.remove());

    // Children before parents, so unwrapped content is already clean
    for (const el of Array.from(root.querySelectorAll('*')).reverse()) {
      const tag = el.localName;
      if (DROP.has(tag)) {
        el.remove();
        continue;
      }
      if (!KEEP.has(tag) || (PHRASING.has(tag) && el.querySelector(BLOCKS))) {
        el.replaceWith(...el.childNodes);
        continue;
      }

      const allowed = ATTRIBUTES['*'].concat(ATTRIBUTES[tag] || []);
      for (const attr of Array.from(el.attributes)) {
        if (!allowed.includes(attr.name)) el.removeAttribute(attr.name);
      }
      for (const name of ['colspan', 'rowspan', 'span', 'start']) {
        if (el.hasAttribute(name) && !/^\d+$/.test(el.getAttribute(name))) el.removeAttribute(name);
      }
      if (el.hasAttribute('reversed')) el.setAttribute('reversed', 'reversed');
      if (el.hasAttribute('dir') && !['ltr', 'rtl', 'auto'].includes(el.getAttribute('dir'))) {
        el.removeAttribute('dir');
      }
      if (el.hasAttribute('lang') && validLanguage(el.getAttribute('lang')) !== el.getAttribute('lang')) {
        el.removeAttribute('lang');
      }
      if (el.hasAttribute('scope') && !['row', 'col', 'rowgroup', 'colgroup'].includes(el.getAttribute('scope'))) {
        el.removeAttribute('scope');
      }
    }

    const ids = new Set();
    root.querySelectorAll('[id]').forEach(el => {
      const id = el.getAttribute('id');
      if (!id || /\s/.test(id) || ids.has(id)) el.removeAttribute('id');
      else ids.add(id);
    });

    root.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      if (href.startsWith('#')) {
        if (!ids.has(href.slice(1))) link.removeAttribute('href');
        return;
      }
      try {
        const url = new URL(href, baseUrl);
        if (['http:', 'https:', 'mailto:'].includes(url.protocol)) link.setAttribute('href', url.href);
        else link.removeAttribute('href');
      } catch {
        link.removeAttribute('href');
      }
    });

    const textWalker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (textWalker.nextNode()) {
      const node = textWalker.currentNode;
      const clean = stripInvalidXmlChars(node.data);
      if (clean !== node.data) node.data = clean;
    }
  }

  // ---- Zip (stored, no compression) ----

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function zipStored(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 10, true); // version needed: 1.0 (stored)
      local.setUint16(8, 0, true); // method: stored
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      // Extra field length stays 0: the EPUB mimetype entry must not have one
      parts.push(local, name, data);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true); // made by
      entry.setUint16(6, 10, true); // version needed
      entry.setUint16(12, dosTime, true);
      entry.setUint16(14, dosDate, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);
      central.push(entry, name);

      offset += 30 + name.length + data.length;
    }

    const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end], { type: 'application/epub+zip' });
  }

  // ---- EPUB files ----

  const STYLESHEET = `body { margin: 0 4%; line-height: 1.5; }
header { margin-bottom: 1.5em; }
h1 { font-size: 1.6em; line-height: 1.25; margin: 0 0 0.4em 0; }
.meta, .source { font-size: 0.85em; color: #555; margin: 0.2em 0; }
img { display: block; max-width: 100%; max-height: 50vh; width: auto; height: auto; margin: 1em auto; }
figure { margin: 1em 0; }
figure img { margin: 0 auto; }
figcaption, .inkpages-caption { font-size: 0.875em; font-style: italic; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #999; }
pre { white-space: pre-wrap; font-size: 0.85em; }
table { border-collapse: collapse; }
td, th { border: 1px solid #999; padding: 0.2em 0.4em; }
`;

  function xhtmlPage({ title, lang, dir, head = '', body }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8"/>
<title>${escapeXml(title)}</title>
${head}</head>
<body>
${body}
</body>
</html>
`;
  }

  /**
   * Build the EPUB.
   * contentRoot: element holding the article (in an inert document); it is modified.
   * Returns { blob, skippedImages }.
   */
  async function build({ title, byline, siteName, lang, dir, sourceUrl, contentRoot, grayscale }) {
    title = title || 'Untitled';
    lang = validLanguage(lang);
    dir = dir === 'rtl' ? 'rtl' : 'ltr';
    const identifier = `urn:uuid:${randomUuid()}`;
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

    const { files: images, skipped } = await packImages(contentRoot, sourceUrl, grayscale);
    cleanForXhtml(contentRoot, sourceUrl);

    // Serialize as XML; a wrapper div keeps the namespace declaration in one place
    const doc = contentRoot.ownerDocument;
    const wrapper = doc.createElement('div');
    wrapper.className = 'article-body';
    wrapper.append(...contentRoot.childNodes);
    const articleBody = new XMLSerializer().serializeToString(wrapper);

    const header = [
      `<h1>${escapeXml(title)}</h1>`,
      byline ? `<p class="meta">${escapeXml(byline)}</p>` : '',
      siteName ? `<p class="meta">${escapeXml(siteName)}</p>` : '',
      sourceUrl ? `<p class="source"><a href="${escapeXml(sourceUrl)}">${escapeXml(sourceUrl)}</a></p>` : ''
    ].filter(Boolean).join('\n');

    const article = xhtmlPage({
      title, lang, dir,
      head: '<link rel="stylesheet" type="text/css" href="style.css"/>\n',
      body: `<header>\n${header}\n</header>\n${articleBody}`
    });

    const nav = xhtmlPage({
      title, lang, dir,
      body: `<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol><li><a href="article.xhtml">${escapeXml(title)}</a></li></ol>
</nav>`
    });

    const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="${identifier}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
<navPoint id="article" playOrder="1"><navLabel><text>${escapeXml(title)}</text></navLabel><content src="article.xhtml"/></navPoint>
</navMap>
</ncx>
`;

    // The first image doubles as the cover (library thumbnails on Kindle and others)
    const imageItems = images.map((image, index) =>
      `<item id="img${index + 1}" href="${image.name}" media-type="image/jpeg"${index === 0 ? ' properties="cover-image"' : ''}/>`
    ).join('\n');

    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">${identifier}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
<dc:language>${lang}</dc:language>
${byline ? `<dc:creator>${escapeXml(byline)}</dc:creator>\n` : ''}${siteName ? `<dc:publisher>${escapeXml(siteName)}</dc:publisher>\n` : ''}${sourceUrl ? `<dc:source>${escapeXml(sourceUrl)}</dc:source>\n` : ''}<meta property="dcterms:modified">${modified}</meta>
${images.length ? '<meta name="cover" content="img1"/>\n' : ''}</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="style" href="style.css" media-type="text/css"/>
<item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>
${imageItems}
</manifest>
<spine toc="ncx"${dir === 'rtl' ? ' page-progression-direction="rtl"' : ''}>
<itemref idref="article"/>
</spine>
</package>
`;

    const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>
`;

    const blob = zipStored([
      { name: 'mimetype', data: 'application/epub+zip' }, // must be first
      { name: 'META-INF/container.xml', data: container },
      { name: 'OEBPS/content.opf', data: opf },
      { name: 'OEBPS/toc.ncx', data: ncx },
      { name: 'OEBPS/nav.xhtml', data: nav },
      { name: 'OEBPS/style.css', data: STYLESHEET },
      { name: 'OEBPS/article.xhtml', data: article },
      ...images.map(image => ({ name: `OEBPS/${image.name}`, data: image.data }))
    ]);

    return { blob, skippedImages: skipped };
  }

  return { build };
})();
