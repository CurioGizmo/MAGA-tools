/**
 * sse_parser.js
 * High-performance Server-Sent Events (SSE) stream chunk parser.
 */

class SseStreamParser {
    constructor(onMessage) {
        this.buffer = '';
        this.onMessage = onMessage;
    }

    feed(chunk) {
        this.buffer += chunk.toString('utf8');
        let newlineIdx;
        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIdx).trim();
            this.buffer = this.buffer.slice(newlineIdx + 1);
            if (line.startsWith('data:')) {
                const jsonStr = line.slice(5).trim();
                if (jsonStr && jsonStr !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(jsonStr);
                        this.onMessage(parsed);
                    } catch (e) {
                        // ignore partial/invalid json in data line
                    }
                }
            }
        }
    }
}

module.exports = {
    SseStreamParser
};
