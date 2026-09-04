# Video Link Extractor Pro (v5.0)

A powerful browser extension for **Chromium-based browsers** (Chrome, Edge, Brave, Opera, Vivaldi, etc.) that automatically sniffs, captures, previews, and exports streaming video and audio links from any webpage.

![Video Link Extractor Pro Screenshot](screenshot-new.png)

---

## 🚀 Key Features

### 🎬 In-Popup Live HLS (`.m3u8`) & Media Player
- Embedded **Hls.js engine** enables native playback of master `.m3u8` streams directly inside the Chrome popup on Windows & Linux without external player software.
- Full video controls with audio/video stream testing.

### 🔍 Real-Time Search & Category Filters
- **Filter Pills**: Instant switching between `All`, `🎬 Streams` (HLS/DASH), `🎥 Videos` (MP4/WebM), and `🎵 Audio` (MP3/AAC/M4A).
- **Search Bar**: Quickly filter streams by URL text, domain name, or filename.

### ⬇️ 1-Click Direct Browser Download
- Direct media file downloads right from the browser popup with sanitized filename inference.

### 📦 Batch Export Suite
- **yt-dlp Batch (`.txt`)**: Generates ready-to-run batch files formatted with per-stream `--add-header "Referer: ..."` for `yt-dlp -a batch.txt`.
- **VLC / MPV Playlist (`.m3u`)**: Export all captured streams as a standard `#EXTM3U` playlist.
- **Structured JSON (`.json`)**: Full export of detected URLs, referer origins, and metadata.

### ⚡ Multi-Layer Deep Stream Sniffing
1. **Network Sniffer**: Intercepts video/audio headers, manifest formats, and query signatures.
2. **Main World API Hooking**: Intercepts `fetch()`, `XMLHttpRequest`, `Hls.prototype.loadSource`, `dashjs.MediaPlayer`, and `HTMLMediaElement.src`.
3. **Shadow DOM & DOM Observer**: Traverses nested Web Components, `<video>`, `<audio>`, and `<source>` elements.
4. **📱 Mobile Safari UA Fallback**: Automatic/manual isolated probe to uncover direct MP4 sources from mobile-optimized video players.
5. **Frame-Level Referer Resolution**: Pinpoints nested iframe origins for CORS/Hotlink protected streams.

---

## 🛠️ Supported Formats

- **Adaptive Streams**: `.m3u8` (HLS), `.mpd` (DASH), `.m3u`
- **Video**: `.mp4`, `.webm`, `.mkv`, `.mov`, `.avi`, `.flv`, `.m4v`, `.ogv`, `.wmv`, `.3gp`
- **Audio**: `.mp3`, `.aac`, `.flac`, `.wav`, `.ogg`, `.opus`, `.m4a`

---

## 📥 Installation

1. Clone or download this repository.
2. Open Chrome/Edge and go to `chrome://extensions/`.
3. Toggle **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select this directory.

---

## 🎮 Quick Actions per Stream Card

| Button | Action |
| :--- | :--- |
| **▶ Play** / **⏹ Stop** | Preview live HLS stream or video file right in the popup |
| **⬇ Save** | 1-Click direct browser download |
| **+ Ref** | Copies `URL\|Referer` (ideal for custom batch scripts) |
| **yt-dlp** | Copies complete `yt-dlp --add-header ... "URL"` command |
| **Copy** | Copies raw media URL |

---

## 📄 License
Open source under MIT license.
