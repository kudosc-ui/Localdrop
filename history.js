// history.js — clipboard history feature logic: grouping, formatting, favorites,
// and search, built on the raw IndexedDB layer in storage.js.

const LocalDropHistory = (() => {
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatCount(n) {
    return new Intl.NumberFormat().format(n);
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(d, today)) return 'Today';
    if (sameDay(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
  }

  /** Groups a (already sorted, newest-first) list of history entries by day label. */
  function groupByDay(entries) {
    const groups = [];
    let current = null;
    for (const entry of entries) {
      const label = dayLabel(entry.timestamp);
      if (!current || current.label !== label) {
        current = { label, items: [] };
        groups.push(current);
      }
      current.items.push(entry);
    }
    return groups;
  }

  async function list() {
    return window.LocalDropStorage.getHistoryList();
  }

  async function favorites() {
    const all = await window.LocalDropStorage.getHistoryList();
    return all.filter((e) => e.favorite);
  }

  async function search(query) {
    return window.LocalDropStorage.searchHistory(query);
  }

  return {
    formatBytes, formatCount, formatTime, dayLabel, groupByDay,
    list, favorites, search,
    toggleFavorite: window.LocalDropStorage.toggleFavorite,
    remove: window.LocalDropStorage.deleteHistoryEntry,
    clear: window.LocalDropStorage.clearHistory,
    getFullText: window.LocalDropStorage.getHistoryFullText,
    updateText: window.LocalDropStorage.updateHistoryText,
  };
})();

window.LocalDropHistory = LocalDropHistory;
