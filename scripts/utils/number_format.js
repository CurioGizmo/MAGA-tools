/**
 * number_format.js
 * SSOT for token and numeric formatting in Node.js / backend scripts.
 */

function formatTokens(num, locale = 'ru-RU') {
    if (!num || num <= 0) return '0';
    if (num < 10000) {
        return num.toLocaleString(locale);
    }
    if (num >= 1000000) {
        const m = num / 1000000;
        return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'M';
    }
    return Math.round(num / 1000) + 'k';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatTokens
    };
}
