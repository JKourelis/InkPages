/**
 * Markdown export - turns the article into a Markdown (.md) text file
 *
 * No library: by export time the article has been through Readability and sanitizeHTML, so a
 * small converter covers what it can contain. Tables become GitHub-style tables; images stay
 * links to the site.
 * Loaded before content.js, which calls InkPagesMarkdown.build().
 */

// eslint-disable-next-line no-unused-vars
var InkPagesMarkdown = (function() {
  'use strict';

  const BLOCKS = new Set([
    'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'details', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
    'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'ul'
  ]);
  const BLOCK_SELECTOR = Array.from(BLOCKS).join(', ');
  // Not text: dropped with everything inside
  const SKIP = new Set([
    'audio', 'button', 'canvas', 'embed', 'iframe', 'input', 'math', 'noscript', 'object', 'script',
    'select', 'source', 'style', 'svg', 'template', 'textarea', 'track', 'video'
  ]);
  const ALNUM = /[\p{L}\p{N}]/u;

  // Backslash-escape characters Markdown would read as formatting. An underscore inside a
  // word (snake_case) can't start emphasis, so it stays as it is. Brackets only make a link as
  // "](" or "]:" (we write no reference definitions), so a citation like [18] stays readable;
  // inside link or image text they are always escaped. `following` is the text after this text
  function escapeText(text, { link = false, following = '' } = {}) {
    return text
      .replace(/[\\`*]/g, '\\$&')
      .replace(/[[\]]/g, (bracket, offset, whole) =>
        (link || (bracket === ']' && /^[(:]/.test(whole[offset + 1] || following)) ? '\\' + bracket : bracket))
      .replace(/_/g, (match, offset, whole) =>
        (ALNUM.test(whole[offset - 1] || '') && ALNUM.test(whole[offset + 1] || '') ? '_' : '\\_'))
      .replace(/<(?=[A-Za-z/!?])/g, '\\<')
      .replace(/&(?=#?\w+;)/g, '\\&');
  }

  // ...and, at the start of a line, what would make it a heading, quote, list or rule
  function escapeLineStart(line) {
    return line
      .replace(/^(#{1,6}|>|[-+](?=\s|$)|-(?=[-\s]*$)|=(?=[=\s]*$)|~~~)/, '\\$1')
      .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2');
  }

  function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function absoluteUrl(href, baseUrl, protocols) {
    if (!href) return null;
    try {
      const url = new URL(href.trim(), baseUrl);
      if (!protocols.includes(url.protocol)) return null;
      // A parenthesis or space would end the link
      return url.href.replace(/[()\s]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    } catch {
      return null;
    }
  }

  function imageUrl(img, baseUrl) {
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    const candidates = [img.getAttribute('src'), img.getAttribute('data-src')]
      .concat(srcset.split(/,\s+/).map(candidate => candidate.trim().split(/\s+/)[0]));
    for (const candidate of candidates) {
      const url = absoluteUrl(candidate, baseUrl, ['http:', 'https:']); // not data: placeholders
      if (url) return url;
    }
    return null;
  }

  // Wrap in a marker such as ** with no space just inside it (that would stop it working)
  function wrap(marker, text) {
    const [, before, core, after] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return core ? before + marker + core + marker + after : text;
  }

  function codeSpan(text) {
    text = text.replace(/\s+/g, ' ');
    if (!text.trim()) return text;
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    const pad = /^`|`$/.test(text) ? ' ' : '';
    return fence + pad + text + pad + fence;
  }

  function inlineChildren(el, state) {
    let text = '';
    el.childNodes.forEach(child => { text += inline(child, state); });
    return text;
  }

  // Inline content as Markdown text; <br> becomes \n, which paragraph() turns into a line break
  function inline(node, state) {
    if (node.nodeType === Node.TEXT_NODE) {
      const next = node.nextSibling;
      return escapeText(node.data.replace(/\s+/g, ' '), { link: state.link, following: next ? next.textContent.charAt(0) : '' });
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.localName;
    if (SKIP.has(tag)) return '';

    switch (tag) {
      case 'br':
        return '\n';
      case 'img': {
        const url = imageUrl(node, state.baseUrl);
        return url ? `![${escapeText(oneLine(node.getAttribute('alt') || ''), { link: true })}](${url})` : '';
      }
      case 'strong':
      case 'b':
        return state.bold ? inlineChildren(node, state) : wrap('**', inlineChildren(node, { ...state, bold: true }));
      case 'em':
      case 'i':
        return state.italic ? inlineChildren(node, state) : wrap('*', inlineChildren(node, { ...state, italic: true }));
      case 's':
      case 'del':
      case 'strike':
        return wrap('~~', inlineChildren(node, state));
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        return codeSpan(node.textContent);
      case 'a': {
        const href = node.getAttribute('href') || '';
        const url = !state.link && !href.startsWith('#') && absoluteUrl(href, state.baseUrl, ['http:', 'https:', 'mailto:']);
        const text = inlineChildren(node, url ? { ...state, link: true } : state).replace(/\s*\n\s*/g, ' ');
        const [, before, core, after] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
        if (!url || !core) return text;
        return before + (node.textContent.trim() === url ? `<${url}>` : `[${core}](${url})`) + after;
      }
      default: {
        const text = inlineChildren(node, state);
        // A block inside a heading or link: keep its words apart from the next ones
        return BLOCKS.has(tag) ? ` ${text} ` : text;
      }
    }
  }

  // Inline text as paragraphs: one <br> is a line break, two or more start a new paragraph
  function paragraph(text) {
    return text.replace(/ *\n */g, '\n').trim()
      .split(/\n{2,}/)
      .map(para => para.split('\n')
        .map(line => escapeLineStart(line.replace(/ {2,}/g, ' ').trim()))
        .filter(Boolean)
        .join('  \n'))
      .filter(Boolean)
      .join('\n\n');
  }

  function isBlock(el) {
    if (SKIP.has(el.localName)) return false;
    // An inline element wrapping blocks (a link around a whole teaser) is read as a block
    return BLOCKS.has(el.localName) || !!el.querySelector(BLOCK_SELECTOR);
  }

  // The children of an element as a list of Markdown blocks (paragraphs, lists, ...)
  function blocks(parent, state) {
    const out = [];
    let run = '';
    const flush = () => {
      const text = paragraph(run);
      if (text) out.push(text);
      run = '';
    };
    parent.childNodes.forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE && isBlock(child)) {
        flush();
        out.push(...block(child, state));
      } else {
        run += inline(child, state);
      }
    });
    flush();
    return out;
  }

  function block(el, state) {
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) {
      // A trailing " #" would be read as the heading's closing marks
      const text = oneLine(inlineChildren(el, state)).replace(/(\s)(#+)$/, '$1\\$2');
      return text ? ['#'.repeat(Number(tag[1])) + ' ' + text] : [];
    }

    switch (tag) {
      case 'ul':
      case 'ol': {
        const list = listBlock(el, state);
        return list ? [list] : [];
      }
      case 'blockquote': {
        const text = blocks(el, state).join('\n\n');
        return text ? [text.split('\n').map(line => (line ? '> ' + line : '>')).join('\n')] : [];
      }
      case 'pre':
        return codeBlock(el);
      case 'hr':
        return ['---'];
      case 'table':
        return tableBlocks(el, state);
      case 'dt': {
        const text = oneLine(inlineChildren(el, { ...state, bold: true }));
        return text ? [escapeLineStart(`**${text}**`)] : [];
      }
      default:
        return blocks(el, state);
    }
  }

  function listBlock(list, state) {
    const ordered = list.localName === 'ol';
    const start = parseInt(list.getAttribute('start'), 10);
    let number = Number.isNaN(start) ? 1 : start;

    // Each item's blocks; anything that isn't an <li> (a list nested without one) joins the item before it
    const entries = [];
    Array.from(list.children).forEach(child => {
      if (child.localName === 'li') {
        entries.push({ number: number++, parts: blocks(child, state) });
      } else if (entries.length) {
        entries[entries.length - 1].parts.push(...block(child, state));
      } else {
        entries.push({ number: number++, parts: block(child, state) });
      }
    });

    const items = [];
    entries.forEach(entry => {
      // A nested list follows the item's text directly, so the list stays tight. Only a list
      // starting at 1 may do that; others would be read as part of the text
      const body = entry.parts.reduce((text, part) =>
        (text ? text + (/^(- |1\. )/.test(part) ? '\n' : '\n\n') + part : part), '');
      if (!body) return;
      const marker = ordered ? `${entry.number}. ` : '- ';
      const indent = ' '.repeat(marker.length);
      items.push(marker + body.split('\n').map((line, i) => (i && line ? indent + line : line)).join('\n'));
    });
    return items.join(items.some(item => item.includes('\n\n')) ? '\n\n' : '\n');
  }

  function codeBlock(pre) {
    const code = pre.textContent.replace(/^\n/, '').replace(/\s+$/, '');
    if (!code) return [];
    const longest = Math.max(0, ...(code.match(/`{3,}/g) || []).map(run => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return [`${fence}\n${code}\n${fence}`];
  }

  function tableBlocks(table, state) {
    const out = table.caption ? blocks(table.caption, state) : [];
    const rows = Array.from(table.rows);
    const width = Math.max(0, ...rows.map(row => row.cells.length));
    if (!width) return out;

    // A layout table (one column, or holding lists, quotes, code or tables): keep the content, not the grid
    if (width === 1 || table.querySelector('table, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6')) {
      rows.forEach(row => Array.from(row.cells).forEach(cell => out.push(...blocks(cell, state))));
      return out;
    }

    const lines = rows.map(row => {
      const cells = Array.from(row.cells).map(cell =>
        blocks(cell, state).join(' ').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|'));
      while (cells.length < width) cells.push('');
      return `| ${cells.join(' | ')} |`;
    });
    // The first row is the header, as GitHub-style tables need one
    lines.splice(1, 0, '|' + ' --- |'.repeat(width));
    out.push(lines.join('\n'));
    return out;
  }

  /**
   * Build the Markdown text: title, byline and site, source link, then the article
   */
  function build({ title, byline, siteName, sourceUrl, contentRoot }) {
    const state = { baseUrl: sourceUrl || contentRoot.ownerDocument.baseURI };
    const header = [];
    if (title) header.push('# ' + oneLine(escapeText(title)));
    const meta = [byline, siteName]
      .map(text => oneLine(text || ''))
      .filter((text, i, all) => text && all.indexOf(text) === i);
    if (meta.length) header.push(escapeLineStart(escapeText(meta.join(' · '))));
    const source = absoluteUrl(sourceUrl, undefined, ['http:', 'https:']);
    if (source) header.push(`Source: <${source}>`);

    return header.concat(blocks(contentRoot, state)).join('\n\n') + '\n';
  }

  return { build };
})();
