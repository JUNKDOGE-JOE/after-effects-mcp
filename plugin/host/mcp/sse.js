'use strict';

class SseWriter {
    constructor(response, options) {
        this.response = response;
        this.keepaliveMs = (options && options.keepaliveMs) || 15000;
        this.nextId = 1;
        this.closed = false;
        this.closeHandlers = [];
        this.timer = null;
    }

    start() {
        const res = this.response;
        res.status(200);
        res.set('Content-Type', 'text/event-stream; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.set('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        this.keepalive();
        this.timer = setInterval(this.keepalive.bind(this), this.keepaliveMs);
        res.on('close', this.close.bind(this));
        return this;
    }

    keepalive() {
        if (!this.closed) this.response.write(': keepalive\n\n');
    }

    send(message) {
        if (this.closed) return false;
        const frame = 'id: ' + this.nextId++ + '\n'
            + 'event: message\n'
            + 'data: ' + JSON.stringify(message) + '\n\n';
        this.response.write(frame);
        return true;
    }

    onClose(handler) {
        this.closeHandlers.push(handler);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearInterval(this.timer);
        this.closeHandlers.forEach(function (handler) { handler(); });
        if (!this.response.writableEnded) this.response.end();
    }
}

module.exports = { SseWriter };
