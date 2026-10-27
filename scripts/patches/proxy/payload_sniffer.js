/**
 * payload_sniffer.js
 * Inspects incoming request body chunks to extract conversationId and model.
 */

const CONV_EXPLICIT_REGEX = /(?:Conversation ID:\s*|["']?(?:cascade_id|conversation_id|cascadeId|conversationId)["']?\s*[:=]\s*["']?)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CONV_FALLBACK_REGEX = /brain[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const MODEL_REGEX = /"(?:model|modelVersion)"\s*:\s*"([^"]+)"/i;

class PayloadSniffer {
    constructor(maxInspectLength = 2000000) {
        this.maxInspectLength = maxInspectLength;
        this.buffer = '';
        this.convId = null;
        this.model = '';
    }

    feed(chunk) {
        if (this.buffer.length < this.maxInspectLength) {
            this.buffer += chunk.toString('utf8');
            if (!this.convId) {
                const mConv = this.buffer.match(CONV_EXPLICIT_REGEX);
                if (mConv) {
                    this.convId = mConv[1];
                } else if (this.buffer.length >= this.maxInspectLength) {
                    // Fallback to path pattern only if no explicit conversation ID was provided in header/body
                    const mFallback = this.buffer.match(CONV_FALLBACK_REGEX);
                    if (mFallback) this.convId = mFallback[1];
                }
            }
            if (!this.model) {
                const mMod = this.buffer.match(MODEL_REGEX);
                if (mMod) this.model = mMod[1];
            }
        }
    }

    getConvId() {
        if (this.convId) return this.convId;
        const m = this.buffer.match(CONV_EXPLICIT_REGEX) || this.buffer.match(CONV_FALLBACK_REGEX);
        if (m) this.convId = m[1];
        return this.convId;
    }

    reset() {
        this.buffer = '';
        this.convId = null;
        this.model = '';
    }
}

module.exports = {
    PayloadSniffer,
    CONV_REGEX: CONV_EXPLICIT_REGEX,
    CONV_EXPLICIT_REGEX,
    CONV_FALLBACK_REGEX,
    MODEL_REGEX
};
