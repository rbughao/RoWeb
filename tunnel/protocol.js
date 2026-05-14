'use strict';

const { EventEmitter } = require('events');

const TYPES = {
  HELLO:     0x01,
  HELLO_ACK: 0x02,
  HTTP_REQ:  0x03,
  HTTP_RES:  0x04,
  PING:      0x05,
  PONG:      0x06,
  ERROR:     0xFF,
};

// Frame layout: [1 byte type][4 bytes requestId BE][4 bytes payloadLen BE][N bytes JSON payload]
const HEADER_SIZE = 9;

function encode(type, requestId, payload) {
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payloadBuf.length);
  frame[0] = type;
  frame.writeUInt32BE(requestId >>> 0, 1);
  frame.writeUInt32BE(payloadBuf.length, 5);
  payloadBuf.copy(frame, HEADER_SIZE);
  return frame;
}

// Accumulates raw socket data and emits complete frames as { type, requestId, payload }.
class FrameParser extends EventEmitter {
  constructor() {
    super();
    this._buf = Buffer.alloc(0);
  }

  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= HEADER_SIZE) {
      const payloadLen = this._buf.readUInt32BE(5);
      if (this._buf.length < HEADER_SIZE + payloadLen) break;

      const type       = this._buf[0];
      const requestId  = this._buf.readUInt32BE(1);
      let payload;
      try {
        payload = JSON.parse(this._buf.slice(HEADER_SIZE, HEADER_SIZE + payloadLen).toString('utf8'));
      } catch (e) {
        this.emit('error', new Error(`Frame parse error: ${e.message}`));
        return;
      }

      this.emit('frame', { type, requestId, payload });
      this._buf = this._buf.slice(HEADER_SIZE + payloadLen);
    }
  }
}

module.exports = { TYPES, encode, FrameParser };
