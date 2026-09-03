export async function saveHistory(entry) {
    const { history = {} } = await chrome.storage.local.get('history');
    const id = Math.random().toString(36).slice(2, 10);
    history[id] = entry;
    await chrome.storage.local.set({ history });
}