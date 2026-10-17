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

// Headers that describe a single connection and must not be forwarded by a proxy (RFC 9110 §7.6.1)
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
                    'te', 'trailer', 'transfer-encoding', 'upgrade'];

function stripHopByHop(headers, extra = []) {
  const listed = String((headers || {}).connection || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const drop = new Set([...HOP_BY_HOP, ...listed, ...extra]);
  return Object.fromEntries(Object.entries(headers || {}).filter(([k]) => !drop.has(k.toLowerCase())));
}

// Accumulates raw socket data and emits complete frames as { type, requestId, payload }.
// Emits 'error' (and stops) if the peer announces a frame larger than maxPayload.
class FrameParser extends EventEmitter {
  constructor(maxPayload = 64 * 1024 * 1024) {
    super();
    this._buf = Buffer.alloc(0);
    this._max = maxPayload;
    this._dead = false;
  }

  push(chunk) {
    if (this._dead) return;
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= HEADER_SIZE) {
      const payloadLen = this._buf.readUInt32BE(5);
      if (payloadLen > this._max) {
        this._dead = true;
        this._buf = Buffer.alloc(0);
        this.emit('error', new Error(`Frame of ${payloadLen} bytes exceeds the ${this._max}-byte limit`));
        return;
      }
      if (this._buf.length < HEADER_SIZE + payloadLen) break;

      const type       = this._buf[0];
      const requestId  = this._buf.readUInt32BE(1);
      let payload;
      try {
        payload = JSON.parse(this._buf.slice(HEADER_SIZE, HEADER_SIZE + payloadLen).toString('utf8'));
      } catch (e) {
        this._dead = true;
        this.emit('error', new Error(`Frame parse error: ${e.message}`));
        return;
      }

      this.emit('frame', { type, requestId, payload });
      this._buf = this._buf.slice(HEADER_SIZE + payloadLen);
    }
  }
}

module.exports = { TYPES, encode, FrameParser, stripHopByHop };
