export async function saveHistory(entry) {
    // Save History toggle lives in settings.js's sync storage, not passed in by callers —
    // checked here so every call site doesn't need to duplicate this guard
    const { saveHistory: enabled } = await chrome.storage.sync.get({ saveHistory: true });
    if (!enabled) return;
    const { history = {} } = await chrome.storage.local.get('history'); // read-modify-write: .set() would otherwise clobber the whole map
    const id = Math.random().toString(36).slice(2, 10); // just needs to be unique within this map, not cryptographically strong
    history[id] = entry;
    await chrome.storage.local.set({ history });
}