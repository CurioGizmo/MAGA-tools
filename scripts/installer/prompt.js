'use strict';
const readline = require('readline');

/**
 * Задаёт пользователю вопрос в терминале и возвращает ответ через Promise.
 * Вынесен в отдельный модуль для разрыва циклической зависимости между
 * terminal_ui.js и patch_service.js.
 *
 * EOF/закрытый stdin (CI, `< /dev/null`) резолвится пустой строкой —
 * то есть ведёт себя как Enter (дефолт), вместо тихого зависания.
 *
 * @param {string} query - Текст вопроса
 * @returns {Promise<string>} Ответ пользователя (trimmed)
 */
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        let settled = false;
        const done = ans => {
            if (settled) return;
            settled = true;
            rl.close();
            resolve(String(ans).trim());
        };
        rl.on('close', () => done(''));
        rl.question(query, ans => done(ans));
    });
}

module.exports = { askQuestion };
