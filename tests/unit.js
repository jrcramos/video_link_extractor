// Unit tests of the add-on readers that need no browser (addon3-parse.js, addon3-text.js).
// Run: node tests/unit.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const root = path.join(__dirname, '..');
['addon3-parse.js', 'addon3-text.js'].forEach((f) => vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f }));
const P = globalThis.__VLE_X3_PARSE__;
const T = globalThis.__VLE_X3_TEXT__;
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const BASE = 'https://cdn.example.test/vod/';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n`, e);
    process.exitCode = 1;
  }
};

test('codec / HDR / audio tags', () => {
  assert.deepEqual(P.techTags('hvc1.2.4.L150.B0,ec-3', 'PQ'), ['HEVC', 'HDR10', 'E-AC-3']);
  assert.deepEqual(P.techTags('dvh1.05.06,ec+3'), ['Dolby Vision', 'Atmos', 'E-AC-3']);
  assert.deepEqual(P.techTags('avc1.640028,mp4a.40.2'), ['H.264', 'AAC']);
  assert.deepEqual(P.techTags('av01.0.05M.08,opus', 'HLG'), ['AV1', 'HLG', 'Opus']);
  assert.deepEqual(P.techTags('mp4a.40.5'), ['HE-AAC']);
  assert.deepEqual(P.techTags(''), []);
});

test('HLS master: tech, HDR per quality, I-frames, images, session data, steering', () => {
  const h = P.hls(fixture('master.m3u8'), `${BASE}master.m3u8`);
  assert.equal(h.master, true);
  assert.equal(h.first, `${BASE}media.m3u8`);
  assert.deepEqual(h.tech, ['HEVC', 'H.264', 'HDR10', 'Atmos', 'E-AC-3', 'AAC']);
  assert.equal(h.vt[`${BASE}media.m3u8`], 'HDR10');
  assert.equal(h.vt[`${BASE}media_1080.m3u8`], undefined);
  assert.deepEqual(h.iframes, [{ url: `${BASE}iframes_720.m3u8`, height: 720, bandwidth: 300000, codecs: 'avc1.64001f' }]);
  assert.deepEqual(h.images, [{ url: `${BASE}thumbs.m3u8`, resolution: '320x180' }]);
  assert.equal(h.session.length, 2);
  assert.deepEqual(h.session[0], { id: 'com.example.title', value: 'Test Programme', uri: '' });
  assert.equal(h.session[1].uri, `${BASE}chapters.json`);
  assert.deepEqual(h.steering, { uri: 'https://cdn.example.test/steering?video=1', pathway: 'CDN-A' });
  assert.deepEqual(h.pathways, ['CDN-A', 'CDN-B']);
  assert.equal(h.ad, null);
});

test('HLS media playlist: ad cues, low latency', () => {
  const h = P.hls(fixture('media.m3u8'), `${BASE}media.m3u8`);
  assert.equal(h.master, false);
  assert.equal(h.ll, true);
  assert.deepEqual(h.ad, { n: 2, kind: 'cue' });
  assert.equal(P.hls('not a playlist', BASE), null);
});

test('DASH: tracks, templates, timeline, ads, HDR, Atmos, thumbnails', () => {
  const d = P.dash(fixture('manifest.mpd'), `${BASE}manifest.mpd`);
  assert.equal(d.live, false);
  assert.equal(d.periods, 2);
  assert.deepEqual(d.ad, { n: 1, kind: 'scte35' });
  assert.deepEqual(d.tech, ['HEVC', 'H.264', 'HDR10', 'Atmos', 'E-AC-3']);
  assert.deepEqual(d.thumbs, [{ url: `${BASE}dash/thumbs/$Number$.jpg`, w: 320, h: 180 }]);
  const v1080 = d.tracks.find((t) => t.id === 'v1080');
  assert.equal(v1080.parts.length, 2, 'one part per period');
  assert.equal(v1080.parts[0].n, 10);
  assert.equal(v1080.parts[1].start, 11);
  assert.equal(v1080.parts[1].n, 5, 'period 2 lasts 20 s');
  const segs = P.dashSegments(v1080);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].init, `${BASE}dash/v1080/init.mp4`);
  assert.equal(segs[0].segments[0].url, `${BASE}dash/v1080/seg-00001.m4s`);
  assert.equal(segs[1].segments[4].url, `${BASE}dash/v1080/seg-00015.m4s`);
  const audio = d.tracks.find((t) => t.kind === 'audio');
  assert.equal(audio.language, 'en');
  assert.deepEqual(audio.tags, ['E-AC-3']);
  const aseg = P.dashSegments(audio)[0].segments;
  assert.equal(aseg.length, 10);
  assert.equal(aseg[1].url, `${BASE}dash/a1/192000.m4s`);
  assert.equal(aseg[1].dur, 4);
  const m3u8 = P.dashPlaylist(v1080, 'ffmpeg -i x');
  assert.match(m3u8, /^#EXTM3U\n/);
  assert.match(m3u8, /#EXT-X-MAP:URI="https:\/\/cdn\.example\.test\/vod\/dash\/v1080\/init\.mp4"/);
  assert.match(m3u8, /#EXT-X-DISCONTINUITY/);
  assert.match(m3u8, /# ffmpeg -i x/);
  assert.equal((m3u8.match(/^#EXTINF:4\.000,$/gm) || []).length, 15);
  assert.match(m3u8, /#EXT-X-ENDLIST\n$/);
});

test('DASH: one file per track, SegmentList', () => {
  const d = P.dash(fixture('single.mpd'), `${BASE}single.mpd`);
  assert.equal(d.tracks.length, 3);
  assert.equal(d.tracks[0].url, `${BASE}video_720.mp4`);
  assert.deepEqual(d.tracks[0].tags, ['AV1']);
  assert.equal(d.tracks[1].url, `${BASE}audio_de.mp4`);
  assert.equal(d.tracks[1].language, 'de');
  const list = P.dashSegments(d.tracks[2]);
  assert.equal(list[0].init, `${BASE}list/init.mp4`);
  assert.deepEqual(list[0].segments.map((s) => s.url), [`${BASE}list/s1.m4s`, `${BASE}list/s2.m4s`, `${BASE}list/s3.m4s`]);
});

test('DASH: big Unix-time timeline ($Time$ beyond 2^53)', () => {
  const mpd = '<MPD type="static" mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate media="v/$Time$.m4s" timescale="10000000"><SegmentTimeline><S t="17000000000000000001" d="40000000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>';
  const d = P.dash(mpd, BASE);
  const segs = P.dashSegments(d.tracks[0])[0].segments;
  assert.equal(segs[0].url, `${BASE}v/17000000000000000001.m4s`);
  assert.equal(segs[1].url, `${BASE}v/17000000000040000001.m4s`);
});

test('DASH: live manifest has no exportable list', () => {
  const mpd = '<MPD type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z"><Period start="PT0S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate media="v/$Number$.m4s" duration="4" startNumber="1"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>';
  const d = P.dash(mpd, BASE);
  assert.equal(d.live, true);
  assert.equal(d.tracks[0].parts.length, 0);
});

test('Smooth Streaming and HDS', () => {
  const s = P.smooth(fixture('smooth.xml'));
  assert.equal(s.duration, 121);
  assert.equal(s.live, false);
  assert.equal(s.variants.type, 'mss');
  assert.equal(s.variants.items.length, 3);
  assert.equal(s.variants.items[0].height, 720);
  assert.equal(s.variants.items[2].kind, 'audio');
  assert.equal(s.variants.items[2].language, 'en');
  assert.deepEqual(s.tech, ['H.264', 'AAC']);
  const f = P.hds(fixture('clip.f4m'));
  assert.equal(f.duration, 95.5);
  assert.equal(f.variants.items.length, 2);
  assert.equal(f.variants.items[0].bandwidth, 1500000);
  assert.equal(P.smooth('<MPD/>'), null);
});

test('MP4 / WebM header formats', () => {
  const box = (type, payload) => {
    const b = Buffer.alloc(8 + payload.length);
    b.writeUInt32BE(8 + payload.length, 0);
    b.write(type, 4, 'latin1');
    payload.copy(b, 8);
    return b;
  };
  const stsd = box('stsd', Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box('hvc1', Buffer.alloc(20))]));
  const colr = box('colr', Buffer.concat([Buffer.from('nclx', 'latin1'), Buffer.from([0, 9, 0, 16, 0, 9, 0x80])]));
  const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')), box('moov', Buffer.concat([stsd, colr, Buffer.alloc(16)]))]);
  assert.deepEqual(P.fileTech(new Uint8Array(mp4)), ['HEVC', 'HDR10']);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20), Buffer.from('V_VP9\0\0A_OPUS', 'latin1'), Buffer.alloc(20)]);
  assert.deepEqual(P.fileTech(new Uint8Array(webm)), ['VP9', 'Opus']);
  assert.deepEqual(P.fileTech(new Uint8Array(40)), []);
});

test('VAST, feeds and playlists', () => {
  const page = 'https://www.example.test/watch/1';
  assert.equal(T.kindOf(fixture('vast.xml')), 'vast');
  assert.deepEqual(T.vastMedia(fixture('vast.xml'), page), ['https://www.example.test/ads/ad-720.mp4', 'https://www.example.test/ads/ad.m3u8', 'https://www.example.test/ads/ad-mezz.mp4']);
  assert.equal(T.kindOf(fixture('feed.xml')), 'rss');
  assert.deepEqual(T.feedMedia(fixture('feed.xml'), page), [
    { url: 'https://www.example.test/pod/episode-2.mp3?src=rss', kind: 'audio' },
    { url: 'https://media.example.test/pod/episode-1', kind: 'audio' },
    { url: 'https://www.example.test/pod/episode-1-video.mp4', kind: 'video' }
  ]);
  assert.equal(T.kindOf(fixture('list.pls')), 'pls');
  assert.deepEqual(T.playlistUrls(fixture('list.pls'), page), ['https://www.example.test/radio/station.mp3', 'https://www.example.test/radio/station.ogg']);
  assert.equal(T.kindOf(fixture('list.xspf')), 'xspf');
  assert.deepEqual(T.playlistUrls(fixture('list.xspf'), page), ['https://www.example.test/music/track-1.flac', 'https://www.example.test/music/track-2.opus']);
  assert.equal(T.kindOf(fixture('list.asx')), 'asx');
  assert.deepEqual(T.playlistUrls(fixture('list.asx'), page), ['https://www.example.test/radio/asx-stream.mp3']);
  assert.equal(T.kindOf('<html><body>hi</body></html>'), '');
  assert.equal(T.kindOf('{"json": true, "a": 1}'), '');
});

console.log(process.exitCode ? 'unit tests FAILED' : `unit tests passed: ${passed}`);
