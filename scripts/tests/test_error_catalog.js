/**
 * test_error_catalog.js
 * Юнит-тесты листового каталога ошибок (Компонент 1 + Компонент 5 плана):
 * 1. classifyErrorKind per-kind: quota, network_dns, network_interrupt,
 *    high_traffic (вкл. голые 500/502), auth (401/403 + текстовый fallback),
 *    timeout, content_filter, unknown.
 * 2. Порядок веток (а)-(е): content_filter раньше quota-текста (негативный
 *    «квота не потрачена»), текст раньше статус-ветки 503, DNS раньше timeout,
 *    auth-fallback после content_filter, edge undefined statusCode, пустой текст.
 * 3. errorNotice полнота: все 8 kind, marker+text не пустые, текст статичен.
 */

'use strict';

const assert = require('assert');
const { classifyErrorKind, errorNotice, ERROR_KINDS } = require('../patches/byok/translators/error_catalog');

console.log('=== Starting Error Catalog Tests ===\n');

// --- 1. per-kind классификация ---
console.log('1. classifyErrorKind per-kind');

// quota
assert.strictEqual(classifyErrorKind(429, 'rate limit exceeded'), 'quota', '429 → quota');
assert.strictEqual(classifyErrorKind(429, 'RESOURCE_EXHAUSTED'), 'quota', 'RESOURCE_EXHAUSTED подпись → quota');
assert.strictEqual(classifyErrorKind(429, 'Quota exceeded for this model'), 'quota', '429 + quota-текст → quota');
assert.strictEqual(classifyErrorKind(503, 'RESOURCE_EXHAUSTED'), 'quota', 'RESOURCE_EXHAUSTED без 429 → quota');

// network_dns
assert.strictEqual(classifyErrorKind(502, 'getaddrinfo ENOTFOUND daily-cloudcode-pa.googleapis.com'), 'network_dns', 'ENOTFOUND → network_dns');
assert.strictEqual(classifyErrorKind(undefined, 'getaddrinfo EAI_AGAIN api.openai.com'), 'network_dns', 'EAI_AGAIN → network_dns');
assert.strictEqual(
    classifyErrorKind(502, 'Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com on 127.0.0.53:53: read udp 127.0.0.1:35730->127.0.0.53:53: i/o timeout'),
    'network_dns', 'кейс №4: Go DNS-текст OAuth-рефреша → network_dns'
);
assert.strictEqual(classifyErrorKind(400, 'no such host'), 'network_dns', 'no such host → network_dns');

// network_interrupt
assert.strictEqual(classifyErrorKind(502, 'Error: aborted'), 'network_interrupt', 'aborted → network_interrupt');
assert.strictEqual(classifyErrorKind(502, 'read ECONNRESET'), 'network_interrupt', 'ECONNRESET → network_interrupt');
assert.strictEqual(classifyErrorKind(502, 'socket error ECONNREFUSED 127.0.0.1:443'), 'network_interrupt', 'socket error + ECONNREFUSED → network_interrupt');
assert.strictEqual(classifyErrorKind(502, 'socket hang up'), 'network_interrupt', 'socket hang up → network_interrupt');
assert.strictEqual(classifyErrorKind(503, 'Upstream stream interrupted (transient)'), 'network_interrupt', '(а) текст interrupted раньше статус-ветки 503');
assert.strictEqual(classifyErrorKind(502, 'Anthropic socket error: write EPIPE'), 'network_interrupt', 'EPIPE → network_interrupt');

// high_traffic
assert.strictEqual(classifyErrorKind(503, 'Service Unavailable'), 'high_traffic', 'голый 503 → high_traffic');
assert.strictEqual(classifyErrorKind(500, 'Internal Server Error'), 'high_traffic', 'голый 500 → high_traffic (SSOT-правило)');
assert.strictEqual(classifyErrorKind(502, 'Bad Gateway'), 'high_traffic', 'голый 502 → high_traffic (SSOT-правило)');
assert.strictEqual(classifyErrorKind(200, 'high traffic, please retry'), 'high_traffic', 'traffic-текст без статус-кода → high_traffic');
assert.strictEqual(classifyErrorKind(200, 'model is overloaded'), 'high_traffic', 'overloaded-текст → high_traffic');

// auth
assert.strictEqual(classifyErrorKind(401, 'Unauthorized'), 'auth', '401 → auth');
assert.strictEqual(classifyErrorKind(403, 'Forbidden'), 'auth', '403 → auth');
assert.strictEqual(classifyErrorKind(400, 'API_KEY_INVALID'), 'auth', 'текстовый fallback API_KEY_INVALID → auth');
assert.strictEqual(classifyErrorKind(400, 'your api key is invalid'), 'auth', 'текстовый fallback invalid api key → auth');
assert.strictEqual(classifyErrorKind(400, 'authentication failed for provider'), 'auth', 'текстовый fallback authentication failed → auth');
assert.strictEqual(classifyErrorKind(500, 'authentication failed for provider'), 'high_traffic', '500 бьёт текстовый auth-fallback (статус-ветка раньше по порядку плана)');

// timeout
assert.strictEqual(classifyErrorKind(504, 'Gateway Timeout'), 'timeout', '504 → timeout');
assert.strictEqual(classifyErrorKind(502, 'connect ETIMEDOUT 142.250.1.1:443'), 'timeout', 'ETIMEDOUT → timeout');

// content_filter
assert.strictEqual(classifyErrorKind(400, 'Request rejected by content filter'), 'content_filter', 'content filter → content_filter');
assert.strictEqual(classifyErrorKind(400, 'Request blocked by safety block'), 'content_filter', 'safety block → content_filter');
assert.strictEqual(
    classifyErrorKind(400, 'Запрос отклонён фильтром контента поставщика модели'),
    'content_filter', 'RU «фильтром контента» → content_filter'
);
assert.strictEqual(classifyErrorKind(400, 'violated content policy'), 'content_filter', 'content policy → content_filter');

// unknown
assert.strictEqual(classifyErrorKind(400, 'Invalid request payload'), 'unknown', 'прочий 400 без сигнатур → unknown');
assert.strictEqual(classifyErrorKind(200, 'something odd'), 'unknown', 'не-ошибочный код без сигнатур → unknown');
console.log('  [✓] per-kind classification verified');

// --- 2. Порядок веток (а)-(е), план 3A MINOR-6 + 4B ---
console.log('\n2. Classification branch order (a)-(e)');

// (а) текст раньше статус-ветки 503
assert.strictEqual(classifyErrorKind(503, 'Upstream stream interrupted (transient)'), 'network_interrupt', '(а) interrupted бьёт 503-high_traffic');

// (б) DNS раньше timeout
assert.strictEqual(classifyErrorKind(502, 'getaddrinfo ETIMEDOUT api.openai.com'), 'network_dns', '(б) DNS-сигнатуры бьют ETIMEDOUT-timeout');

// (в) content_filter раньше quota-текста (негативный, 4B C1 — критично!)
assert.strictEqual(
    classifyErrorKind(400, 'Запрос отклонён фильтром контента поставщика модели. Ваша квота не потрачена.'),
    'content_filter', '(в) «квота не потрачена» НЕ должен матчить quota — только content_filter'
);

// (г) content_filter раньше auth/quota-текста
assert.strictEqual(
    classifyErrorKind(400, 'your API key and quota are fine — the request was rejected by a safety block'),
    'content_filter', '(г) quota+auth-текст при safety block → content_filter'
);

// (д) edge: undefined statusCode
assert.strictEqual(classifyErrorKind(undefined, 'ENOTFOUND'), 'network_dns', '(д) undefined код + DNS → network_dns');
assert.strictEqual(classifyErrorKind(undefined, ''), 'unknown', '(д) undefined код + пустой текст → unknown');

// (е) пустой текст
assert.strictEqual(classifyErrorKind(503, ''), 'high_traffic', '(е) пустой текст + 503 → статус-ветка');
assert.strictEqual(classifyErrorKind(400, ''), 'unknown', '(е) пустой текст + 400 → unknown');
console.log('  [✓] branch order invariants verified (content_filter first, DNS before timeout, interrupted before 503)');

// --- 3. errorNotice полнота: все 8 kind ---
console.log('\n3. errorNotice completeness for all 8 kinds');
const EXPECTED_KINDS = ['quota', 'network_dns', 'network_interrupt', 'high_traffic', 'auth', 'timeout', 'content_filter', 'unknown'];
assert.deepStrictEqual(ERROR_KINDS.slice().sort(), EXPECTED_KINDS.slice().sort(), 'Каталог обязан содержать ровно 8 kind');
for (const kind of EXPECTED_KINDS) {
    const notice = errorNotice(kind);
    assert.ok(notice && typeof notice === 'object', `notice(${kind}) обязан вернуть объект`);
    assert.ok(typeof notice.marker === 'string' && notice.marker.length > 0, `marker для ${kind} не пуст`);
    assert.ok(typeof notice.text === 'string' && notice.text.length > 0, `text для ${kind} не пуст`);
    assert.ok(notice.marker.startsWith('[AGY-ERR:'), `marker для ${kind} обязан начинаться с [AGY-ERR:`);
    assert.ok(notice.marker.toLowerCase() === `[agy-err:${kind}]`, `marker для ${kind} обязан быть [AGY-ERR:${kind}]`);
    // Текст статичен (не зависит от входа): два вызова дают идентичный результат
    assert.deepStrictEqual(errorNotice(kind), notice, `notice(${kind}) детерминирован и статичен`);
}
// Неизвестный kind деградирует в unknown
assert.deepStrictEqual(errorNotice('nonexistent_kind'), errorNotice('unknown'), 'неизвестный kind → unknown-notice');
// RU-тексты ключевых kind (контракт фронтенд-сканеров)
assert.ok(errorNotice('quota').text.includes('429'), 'quota-текст упоминает 429 (матчится существующей quota-веткой classifier)');
assert.ok(errorNotice('auth').text.includes('Автоповтор отключён'), 'auth-текст: fatal, без автоповтора');
assert.ok(errorNotice('content_filter').text.includes('Автоповтор отключён'), 'content_filter-текст: fatal, без автоповтора');
console.log('  [✓] errorNotice complete: 8 kinds, markers + static texts');

// --- 4. Листовость каталога: никаких require-вызовов (инвариант циклов) ---
console.log('\n4. Leaf module invariant (no requires)');
const catalogSource = require('fs').readFileSync(require('path').join(__dirname, '../patches/byok/translators/error_catalog.js'), 'utf8');
// Убираем комментарии (упрощённо: строковые литералы в каталоге не содержат
// ни «//», ни «require(») — считаем только реальные require-вызовы в коде.
const codeOnly = catalogSource
    .replace(/\/\*[\s\S]*?\*\//g, '')   // блочные комментарии
    .replace(/\/\/.*$/gm, '');          // строчные комментарии
const requireMatches = codeOnly.match(/require\s*\(/g) || [];
assert.strictEqual(requireMatches.length, 0, 'error_catalog НЕ должен содержать require-вызовы (особенно stream_converter — цикл)');
console.log('  [✓] error_catalog is a true leaf module (0 require calls)');

console.log('\n=== ALL ERROR CATALOG TESTS PASSED! ✓ ===');
