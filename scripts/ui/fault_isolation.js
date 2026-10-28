/**
 * fault_isolation.js
 * Roadmap item 4: fault isolation for injected UI modules.
 *
 * Design contract:
 * - A thrown error inside a MutationObserver callback / rAF tick / interval
 *   of ONE injected module must never break the host page or sibling modules.
 * - Errors are logged once per (module, tag) per session (rate-limited), with
 *   the module name in the prefix — full text to console, summary line into
 *   module_errors log via console.error only (no file IO in renderer).
 * - guard() degrades gracefully: a failing observer check is skipped, the
 *   observer stays alive for future mutations.
 */
'use strict';

const _recentErrors = Object.create(null);
const RATE_LIMIT_MS = 30000;

/**
 * Wraps a callback so that any exception is caught, rate-limited-logged
 * with the module tag, and swallowed (graceful degradation).
 *
 * @param {string} moduleTag - short module name, e.g. 'HUD', 'BYOK-UI'
 * @param {string} tag - call site, e.g. 'observer-cb'
 * @param {Function} fn - the guarded callback
 */
function guard(moduleTag, tag, fn) {
    if (typeof fn !== 'function') return fn;
    return function guarded(...args) {
        try {
            return fn.apply(this, args);
        } catch (err) {
            _logFault(moduleTag, tag, err);
            return undefined;
        }
    };
}

/**
 * Wraps an async callback: rejections are caught + logged, never propagate
 * as unhandled rejections inside the host page.
 */
function guardAsync(moduleTag, tag, fn) {
    if (typeof fn !== 'function') return fn;
    return function guardedAsync(...args) {
        try {
            const result = fn.apply(this, args);
            if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
                return result.catch(err => { _logFault(moduleTag, tag, err); return undefined; });
            }
            return result;
        } catch (err) {
            _logFault(moduleTag, tag, err);
            return Promise.resolve(undefined);
        }
    };
}

function _logFault(moduleTag, tag, err) {
    const key = `${moduleTag}:${tag}`;
    const now = Date.now();
    if (_recentErrors[key] && (now - _recentErrors[key]) < RATE_LIMIT_MS) return; // rate-limited
    _recentErrors[key] = now;
    const msg = (err && err.message) ? err.message : String(err);
    // Single console line — enough for DevTools diagnostics without flooding
    console.error(`[agy:${moduleTag}] fault in ${tag} (isolated, UI continues): ${msg}`);
}

/**
 * Global safety net: installs window.onerror + unhandledrejection hooks that
 * only log (never prevent default host handling). Injected once by the
 * preload bridge before widget injection.
 */
function installGlobalFaultBoundary() {
    if (typeof window === 'undefined') return false;
    if (window.__AGY_FAULT_BOUNDARY__) return true;
    window.__AGY_FAULT_BOUNDARY__ = true;

    window.addEventListener('error', (e) => {
        if (e && e.target && e.target !== window) return; // resource load errors — host domain
        const src = (e && e.filename) ? `${e.filename}:${e.lineno}` : 'unknown';
        console.error(`[agy:boundary] renderer error (isolated): ${e && e.message} @ ${src}`);
    }, true);

    window.addEventListener('unhandledrejection', (e) => {
        const reason = (e && e.reason && e.reason.message) ? e.reason.message : String((e && e.reason) || 'unknown');
        console.error(`[agy:boundary] unhandled rejection (isolated): ${reason}`);
    });
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { guard, guardAsync, installGlobalFaultBoundary };
}
// Bundle-mode alias: inside concatenated IIFE bundles (no module system),
// expose the API so sibling modules can use AgyFaultIsolation.guard(...).
if (typeof window !== 'undefined') {
    window.AgyFaultIsolation = { guard, guardAsync, installGlobalFaultBoundary };
}
