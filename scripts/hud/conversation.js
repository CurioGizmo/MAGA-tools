/**
 * ConversationDetector - Robust multi-source detection of the active conversation ID.
 */
class ConversationDetector {
  static getActiveConvId() {
    if (typeof document === 'undefined') return null;

    // 1. Main chat cascade container
    const mainChat = document.querySelector('div[class*="w-full flex h-full"][data-cascade-id]');
    if (mainChat) {
      const cid = mainChat.getAttribute('data-cascade-id');
      if (cid) return cid;
    }

    // 2. URL Path regex (/c/<uuid>)
    if (typeof window !== 'undefined' && window.location) {
      const urlMatch = (window.location.pathname || '').match(/\/c\/([a-f0-9-]+)/);
      if (urlMatch) return urlMatch[1];
    }

    // 3. Active conversation item in sidebar
    const activeLink = document.querySelector(
      'a[href^="/c/"].bg-secondary, [data-conversation-id].bg-secondary, [data-cascade-id].bg-secondary, [data-cascade-id].bg-sidebar-secondary'
    );
    if (activeLink) {
      const href = activeLink.getAttribute('href');
      if (href) {
        const hm = href.match(/\/c\/([a-f0-9-]+)/);
        if (hm) return hm[1];
      }
      const cid = activeLink.getAttribute('data-conversation-id') || activeLink.getAttribute('data-cascade-id');
      if (cid) return cid;
    }

    // 4. Split-pane or alternative cascade container
    const pane = document.querySelector('[data-pane-id] [data-cascade-id], [data-cascade-id]:not([class*="select-none"])');
    if (pane) {
      const cid = pane.getAttribute('data-cascade-id');
      if (cid) return cid;
    }

    return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ConversationDetector };
}
