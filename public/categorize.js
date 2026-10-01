/* Story → ticker category. Shared by the server (require) and the browser (window.categorize). */
(function (root) {
  'use strict';

  const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const norm = (s) => words(s).join(' ');

  // Does a match word/phrase appear in the story's RSS categories or its URL path?
  function storyMatches(item, kw) {
    const k = norm(kw);
    if (!k) return false;
    for (const c of item.categories || []) {
      const n = ` ${norm(c)} `;
      if (n.includes(` ${k} `)) return true;
    }
    if (item.link && !k.includes(' ')) {
      let p = '';
      try { p = new URL(item.link).pathname; } catch { p = ''; }
      if (words(p).includes(k)) return true;
    }
    return false;
  }

  /**
   * Priority: the feed's default category, then the first category (in list order)
   * whose match words appear in the story's RSS categories or URL.
   * Returns a category id or null.
   */
  function categorize(item, feed, categories) {
    const cats = categories || [];
    if (feed && feed.category && cats.some((c) => c.id === feed.category)) return feed.category;
    for (const c of cats) {
      if ((c.match || []).some((kw) => storyMatches(item, kw))) return c.id;
    }
    return null;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { categorize };
  else root.categorize = categorize;
})(this);
