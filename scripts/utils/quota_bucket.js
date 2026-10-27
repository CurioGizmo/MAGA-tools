/**
 * quota_bucket.js
 * SSOT for Quota Group and Bucket classification, matching, and extraction.
 */

/**
 * Maps a model id to its Google quota group key ('gemini' or 'claudeGpt').
 */
function googleGroupForModel(rawId) {
  return /gemini/i.test(String(rawId)) ? 'gemini' : 'claudeGpt';
}

/**
 * Finds the quota group object in a retrieveUserQuotaSummary response by group key.
 */
function findQuotaGroup(groups, groupKey) {
  if (!Array.isArray(groups)) return null;
  const pattern = groupKey === 'gemini' ? /gemini/i : /claude|gpt/i;
  return groups.find(g => g && pattern.test(String(g.displayName || ''))) || null;
}

/**
 * Extracts a bucket by window ('5h' | 'weekly') from a quota group.
 */
function extractQuotaBucket(group, window) {
  if (!group || !Array.isArray(group.buckets)) return null;
  const idToken = window === '5h' ? '5h' : 'weekly';
  const namePattern = window === '5h' ? /five|5h|5.?hour/i : /weekly/i;
  return group.buckets.find(b => b && (
    String(b.window || '') === window ||
    String(b.bucketId || '').includes(idToken) ||
    namePattern.test(String(b.displayName || ''))
  )) || null;
}

/**
 * Extracts the 5h rolling bucket (or daily/first fallback) from a group.
 */
function extract5hBucket(group) {
  if (!group || !Array.isArray(group.buckets) || !group.buckets.length) return null;
  return extractQuotaBucket(group, '5h') || group.buckets.find(b => /day|daily|24/i.test(b.displayName || '')) || group.buckets[0] || null;
}

/**
 * Normalizes a bucket's remaining fraction from protojson oneof or flat property.
 */
function bucketRemainingFraction(bucket) {
  if (!bucket) return null;
  const rem = bucket.remaining;
  if (rem && typeof rem === 'object') {
    if (rem.case === 'remainingFraction' && typeof rem.value === 'number') return rem.value;
    if (typeof rem.remainingFraction === 'number') return rem.remainingFraction;
  }
  if (typeof bucket.remainingFraction === 'number') return bucket.remainingFraction;
  return null;
}

/**
 * Bucket reset time in epoch ms (handles seconds string/number or ISO string).
 */
function bucketResetTimeMs(bucket) {
  if (!bucket || !bucket.resetTime) return null;
  const raw = bucket.resetTime.seconds;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    if (typeof bucket.resetTime === 'string' || typeof bucket.resetTime === 'number') {
      const ms = new Date(bucket.resetTime).getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  }
  const s = Number(raw);
  if (!Number.isFinite(s)) return null;
  return s * 1000;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    googleGroupForModel,
    findQuotaGroup,
    extractQuotaBucket,
    extract5hBucket,
    bucketRemainingFraction,
    bucketResetTimeMs
  };
}
