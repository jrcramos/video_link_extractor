// Local test server for the browser tests (tests/run.js): the test pages, the fixtures, small fake media files, an
// endless Icecast-style radio stream, a WebSocket that sends media bytes, a WHEP endpoint.
// Standalone: node tests/server.js [port]   then open http://127.0.0.1:<port>/pages/x3.html
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;

// The first bytes of an MP4 file: ftyp + moov with an HEVC sample entry and a PQ (HDR10) colour box
function fakeMp4() {
  const box = (type, payload) => {
    const b = Buffer.alloc(8 + payload.length);
    b.writeUInt32BE(8 + payload.length, 0);
    b.write(type, 4, 'latin1');
    payload.copy(b, 8);
    return b;
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(42000, 16); // duration: 42 s
  const stsd = box('stsd', Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box('hvc1', Buffer.alloc(20))]));
  const colr = box('colr', Buffer.concat([Buffer.from('nclx', 'latin1'), Buffer.from([0, 9, 0, 16, 0, 9, 0x80])]));
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')), box('moov', Buffer.concat([box('mvhd', mvhd), stsd, colr])), Buffer.alloc(4096)]);
}
const MP4 = fakeMp4();
const FLV = Buffer.concat([Buffer.from('FLV', 'latin1'), Buffer.from([1, 5, 0, 0, 0, 9, 0, 0, 0, 0]), Buffer.alloc(64)]);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml',
  '.xml': 'text/xml', '.f4m': 'application/f4m+xml', '.pls': 'audio/x-scpls', '.xspf': 'application/xspf+xml',
  '.asx': 'video/x-ms-asf', '.vtt': 'text/vtt', '.json': 'application/json', '.jpg': 'image/jpeg'
};

function send(res, status, type, body, extra) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...(extra || {}) });
  res.end(body);
}

function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  const host = req.headers.host;

  if (p.startsWith('/pages/') || p.startsWith('/fixtures/')) {
    const file = path.join(DIR, p);
    if (!file.startsWith(DIR) || !fs.existsSync(file)) return send(res, 404, 'text/plain', 'not found');
    let type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (u.searchParams.get('type')) type = u.searchParams.get('type');
    return send(res, 200, type, fs.readFileSync(file, 'utf8').split('{{HOST}}').join(host), p.endsWith('.html') ? { 'Set-Cookie': 'vle_session=abc123; Path=/' } : null);
  }
  // Module 1 (existing): an HLS playlist at an address that does not say so
  if (p === '/api/stream') return send(res, 200, 'text/plain', fs.readFileSync(path.join(DIR, 'fixtures/media.m3u8'), 'utf8'));
  // Module 6 (existing): JSON with plain and escaped media URLs
  if (p === '/api/video.json') return send(res, 200, 'application/json', JSON.stringify({ url: `http://${host}/media/api-video.mp4` }).replace('}', `,"alt":"http:\\/\\/${host}\\/media\\/escaped.flac"}`));
  // Smooth Streaming (served as plain XML, which the existing filters do not list) and Azure-style HLS
  if (/\.ism\/manifest$/i.test(p)) return send(res, 200, 'text/xml', fs.readFileSync(path.join(DIR, 'fixtures/smooth.xml'), 'utf8'));
  if (/\.ism\/manifest\(format=m3u8-aapl\)$/i.test(p)) return send(res, 200, 'text/plain', fs.readFileSync(path.join(DIR, 'fixtures/master.m3u8'), 'utf8'));
  if (p === '/hds/clip.f4m') return send(res, 200, 'application/f4m+xml', fs.readFileSync(path.join(DIR, 'fixtures/clip.f4m'), 'utf8'));
  // fake media: an MP4 header (HEVC, HDR10, 42 s); generic segments; a whole file played from memory
  if (/^\/(?:media|ads|seg|pod|music)\//.test(p) && /\.(?:mp4|m4s|flac|opus|mp3)$/.test(p)) {
    const type = p.endsWith('.mp3') ? 'audio/mpeg' : (p.endsWith('.flac') ? 'audio/flac' : (p.endsWith('.opus') ? 'audio/ogg' : 'video/mp4'));
    return send(res, 200, type, MP4);
  }
  if (p === '/bin/track') return send(res, 200, 'application/octet-stream', MP4);
  if (p.endsWith('.jpg')) return send(res, 200, 'image/jpeg', Buffer.alloc(10));
  // Icecast-style radio: never ends, station in icy- headers
  if (p === '/radio/stream' || p === '/radio/ogg' || p === '/radio/station.mp3' || p === '/radio/station.ogg' || p === '/radio/asx-stream.mp3') {
    res.writeHead(200, {
      'Content-Type': p.includes('ogg') ? 'application/ogg' : 'audio/mpeg', 'icy-name': 'Test Radio', 'icy-br': '128',
      'icy-genre': 'Testing', 'icy-url': 'https://radio.example.test/', 'Cache-Control': 'no-store'
    });
    const t = setInterval(() => res.write(Buffer.alloc(1024)), 300);
    req.on('close', () => clearInterval(t));
    return;
  }
  // WHEP endpoint: takes an SDP offer
  if (p === '/whep' && req.method === 'POST') {
    req.resume();
    return req.on('end', () => send(res, 201, 'application/sdp', 'v=0\r\n', { Location: '/whep/session/1' }));
  }
  return send(res, 404, 'text/plain', 'not found');
}

// Minimal WebSocket: a text message naming a media URL (existing module 10), then FLV bytes (module 13)
function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const frame = (opcode, payload) => {
    const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
    return Buffer.concat([head, payload]);
  };
  socket.on('error', () => {});
  socket.on('data', () => {});
  if (req.url === '/ws-burst') { // tests/perf.js: 3000 messages, text and binary
    const text = Buffer.from(JSON.stringify({ type: 'tick', n: 1, note: 'no media here' }));
    const bin = Buffer.alloc(100, 7);
    const all = [];
    for (let i = 0; i < 3000; i++) all.push(frame(i % 2 ? 2 : 1, i % 2 ? bin : text));
    socket.write(Buffer.concat(all));
    return;
  }
  setTimeout(() => {
    if (socket.destroyed) return;
    socket.write(frame(1, Buffer.from(JSON.stringify({ event: 'play', src: `http://${req.headers.host}/media/ws-announced.mp4` }))));
    socket.write(frame(2, FLV));
  }, 200);
}

function start(port) {
  const server = http.createServer(handler);
  server.on('upgrade', upgrade);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 8765;
  start(port).then(() => console.log(`test server on http://127.0.0.1:${port}/pages/`));
}
module.exports = { start };
