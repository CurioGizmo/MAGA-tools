const QUOTA_5H_EXCLUDE_THRESHOLD = 0.05;   // 5% of the 5h window remaining
const QUOTA_WEEKLY_EXCLUDE_THRESHOLD = 0.02; // 2% of the weekly window remaining
const QUOTA_STALE_TTL_MS = 120 * 1000;     // older data -> unknown -> fail-open
const QUOTA_429_COOLDOWN_MS = 10 * 60 * 1000; // reactive 429 learning fallback

function _qb() {
    try { return require('../agy_utils/quota_bucket'); }
    catch (_) { return require('../../utils/quota_bucket'); }
}
const {
    googleGroupForModel,
    findQuotaGroup,
    extractQuotaBucket,
    bucketRemainingFraction,
    bucketResetTimeMs
} = _qb();


/**
 * Decides whether a quota group is exhausted for routing purposes.
 * 5h is PRIMARY (threshold 5%), weekly SECONDARY (2%). A window whose
 * resetTime has already passed counts as refreshed (available). Stale
 * data (> QUOTA_STALE_TTL_MS) and missing data fail open (no exclusion).
 * Reactive 429 cooldowns are honored when fresher data is absent.
 * Returns { exhausted: boolean, reason: string }.
 *
 * Pure: cooldowns are passed in explicitly (Map groupKey -> expiry ms),
 * `now` is an epoch-ms number.
 */
function isGroupQuotaExhausted(groupKey, latestQuota5h, cooldowns, now) {
    const nowMs = (typeof now === 'function' ? now() : now);

    // Reactive 429 learning: cooldown active -> exhausted until it expires
    const cooldownUntil = (cooldowns && cooldowns.get(groupKey)) || 0;
    if (cooldownUntil > nowMs) {
        return { exhausted: true, reason: `429-cooldown until ${new Date(cooldownUntil).toISOString()}` };
    }
    if (cooldownUntil > 0) cooldowns.delete(groupKey);

    if (!latestQuota5h || !latestQuota5h.hasData || !Array.isArray(latestQuota5h.groups)) {
        return { exhausted: false, reason: 'no-data' }; // fail-open
    }
    if (nowMs - (latestQuota5h.timestamp || 0) > QUOTA_STALE_TTL_MS) {
        return { exhausted: false, reason: 'stale' }; // fail-open
    }

    const group = findQuotaGroup(latestQuota5h.groups, groupKey);
    if (!group) return { exhausted: false, reason: 'group-not-found' };

    // Evaluate BOTH windows before deciding: a passed resetTime refreshes
    // only its own window, so a 5h reset must NOT mask an exhausted weekly
    // bucket (and vice versa). No early returns between the two checks.
    let exhausted = false;
    let reason = 'ok';

    // PRIMARY: 5h bucket
    const b5h = extractQuotaBucket(group, '5h');
    if (b5h) {
        const frac = bucketRemainingFraction(b5h);
        const resetMs = bucketResetTimeMs(b5h);
        if (frac !== null && frac < QUOTA_5H_EXCLUDE_THRESHOLD && !(resetMs !== null && resetMs <= nowMs)) {
            exhausted = true;
            reason = `5h=${frac.toFixed(4)} < ${QUOTA_5H_EXCLUDE_THRESHOLD}`;
        }
    }

    // SECONDARY: weekly bucket
    if (!exhausted) {
        const bW = extractQuotaBucket(group, 'weekly');
        if (bW) {
            const frac = bucketRemainingFraction(bW);
            const resetMs = bucketResetTimeMs(bW);
            if (frac !== null && frac < QUOTA_WEEKLY_EXCLUDE_THRESHOLD && !(resetMs !== null && resetMs <= nowMs)) {
                exhausted = true;
                reason = `weekly=${frac.toFixed(4)} < ${QUOTA_WEEKLY_EXCLUDE_THRESHOLD}`;
            }
        }
    }

    return { exhausted, reason };
}

module.exports = {
    QUOTA_5H_EXCLUDE_THRESHOLD,
    QUOTA_WEEKLY_EXCLUDE_THRESHOLD,
    QUOTA_STALE_TTL_MS,
    QUOTA_429_COOLDOWN_MS,
    googleGroupForModel,
    findQuotaGroup,
    extractQuotaBucket,
    bucketRemainingFraction,
    bucketResetTimeMs,
    isGroupQuotaExhausted
};
