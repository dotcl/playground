// Gets the page cross-origin isolated on a host that cannot send the headers.
//
// The headers are decided when the document arrives, so registering coi-sw.js
// does nothing for the page already open: it has to be loaded again, through
// the worker. That is one reload on a first visit, and none after — the worker
// stays registered.
//
// A classic script, ahead of the page's module, so it runs before anything is
// fetched. window.coi resolves true when a reload is on its way, and the page
// waits on it rather than start downloading a runtime it is about to discard.

window.coi = (async () => {
    if (window.crossOriginIsolated) {
        try { sessionStorage.removeItem('coi-reloaded'); } catch {}
        return false;
    }
    if (!window.isSecureContext || !navigator.serviceWorker) return false;
    // Reloaded once already and still not isolated (a hard reload bypasses the
    // worker, for one): another reload would only loop.
    try { if (sessionStorage.getItem('coi-reloaded')) return false; } catch { return false; }
    try {
        await navigator.serviceWorker.register('coi-sw.js');
        await navigator.serviceWorker.ready;
    } catch { return false; }
    sessionStorage.setItem('coi-reloaded', '1');
    location.reload();
    return true;
})();
