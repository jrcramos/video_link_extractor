# Video Link Extractor Pro

A browser extension for **Chromium-based browsers** (Chrome, Edge, Brave, Opera, Vivaldi, etc.) that automatically detects and extracts video and audio links from network requests on any webpage. Perfect for downloading media content, analyzing streaming URLs, or archiving multimedia resources.

![Extension Screenshot](screenshot-new.png)

*Updated UI with gradient background, full link display (no truncation), and modern styling*

## Features

- **Real-time Detection**: Automatically captures video and audio URLs as you browse
- **Multiple Format Support**: Detects 25+ media formats including MP4, M3U8, MPD, WebM, MP3, and more
- **Clean Interface**: Simple popup with organized list of detected links
- **One-Click Copy**: Copy any link to clipboard with a single click
- **Tab Management**: Links are organized per tab with automatic cleanup
- **Memory Efficient**: Automatically cleans up data when tabs are closed

## Supported Formats

The extension detects the following media formats:

**Video Formats:**
- MP4, WebM, AVI, MOV, MKV, FLV, 3GP
- M4V, OGV, ASF, DIVX, MPG, MPEG, WMV

**Audio Formats:**
- MP3, AAC, FLAC, WAV, OGG, OPUS

**Streaming Formats:**
- M3U8 (HLS), MPD (DASH), M3U
- TS (Transport Stream), RM (RealMedia)

## Installation

> **Compatible with:** Chrome, Edge, Brave, Opera, Vivaldi, and other Chromium-based browsers

### From Chrome or Edge Web Store (Recommended)
*Note: This extension may not be published on Chrome Web Store yet*

### Manual Installation (Developer Mode)

1. **Download the Extension**
   - Clone this repository: `git clone https://github.com/jrcramos/video_link_extractor.git`
   - Or download as ZIP and extract

2. **Enable Developer Mode**
   - Open your Chromium browser and navigate to:
     - Chrome: `chrome://extensions/`
     - Edge: `edge://extensions/`
     - Brave: `brave://extensions/`
     - Opera: `opera://extensions/`
   - Toggle "Developer mode" in the top right corner

3. **Load the Extension**
   - Click "Load unpacked" button
   - Select the extension folder containing `manifest.json`
   - The extension icon should appear in your browser toolbar

## Usage

### Basic Usage

1. **Browse Websites**: Navigate to any webpage with video or audio content
2. **Open Extension**: Click the Video Link Extractor icon in your toolbar
3. **View Links**: All detected media links will be displayed in the popup
4. **Copy Links**: Click the "Copy" button next to any link to copy it to clipboard
5. **Clear Links**: Use the "Clear" button to remove all links for the current tab

### Tips for Better Results

- **Refresh Pages**: Some sites load media dynamically - try refreshing if no links appear
- **Interact with Content**: Play videos or audio to trigger network requests
- **Check Multiple Tabs**: Links are tracked separately for each browser tab
- **Streaming Sites**: Works great with streaming platforms, news sites, and social media

## Technical Details

### Architecture

- **Background Script** (`background.js`): Monitors network requests using Chromium's webRequest API
- **Popup Interface** (`popup.html`, `popup.js`): User interface for displaying and managing links
- **Content Script** (`content.js`): Handles additional page-specific functionality
- **Manifest V3**: Uses the latest Chromium extension architecture for security and performance

### Permissions

The extension requires these permissions:
- `webRequest`: To monitor network requests for media files
- `activeTab`: To identify the current tab
- `scripting`: For content script injection
- `clipboardWrite`: To copy links to clipboard
- `<all_urls>`: To detect media on any website

### Data Storage

- Links are stored temporarily in memory (RAM) only
- Data is automatically cleared when tabs are closed
- No persistent storage or data collection
- Privacy-focused design

## Development

### Project Structure

```
video_link_extractor/
├── manifest.json          # Extension configuration
├── background.js          # Service worker for request monitoring
├── popup.html            # Extension popup UI
├── popup.js              # Popup functionality
├── content.js            # Content script (if needed)
├── icons/                # Extension icons
│   ├── icon16.png
│   └── icon16.jpg
└── README.md             # This file
```

### Building from Source

1. **Clone Repository**
   ```bash
   git clone https://github.com/jrcramos/video_link_extractor.git
   cd video_link_extractor
   ```

2. **No Build Process Required**
   - This is a vanilla JavaScript extension
   - No compilation or bundling needed
   - Load directly in Chromium browser Developer mode

### Contributing

1. **Fork the Repository**
2. **Create a Feature Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make Changes**
   - Follow existing code style
   - Test thoroughly in Chromium browsers
   - Update documentation if needed
4. **Submit Pull Request**

### Testing

- Load extension in any Chromium browser (Chrome, Edge, Brave, etc.) with Developer mode
- Test on various websites (YouTube, Vimeo, news sites, etc.)
- Verify all supported formats are detected
- Check popup functionality and clipboard operations
- Test tab switching and cleanup behavior

## Troubleshooting

### Common Issues

**No Links Detected**
- Ensure the page has loaded completely
- Try refreshing the page
- Interact with media content (play videos)
- Check if the site uses non-standard streaming methods

**Extension Not Working**
- Verify Developer mode is enabled in your Chromium browser
- Check browser console for errors (`F12` → Console)
- Try reloading the extension in your browser's extensions page
- Ensure you're using a compatible Chromium browser version

**Links Not Copying**
- Modern browsers require HTTPS for clipboard access
- Check if clipboard permissions are granted
- Try clicking the link to open in a new tab instead

### Reporting Issues

Please report bugs or feature requests on GitHub:
1. Go to [Issues page](https://github.com/jrcramos/video_link_extractor/issues)
2. Search for existing similar issues
3. Create a new issue with:
   - Browser name and version (e.g., Chrome 120, Edge 120, Brave 1.60)
   - Website URL where issue occurs
   - Steps to reproduce
   - Expected vs actual behavior

## Privacy & Security

- **No Data Collection**: The extension does not collect or transmit any personal data
- **Local Processing**: All link detection happens locally in your browser
- **No External Requests**: Extension doesn't communicate with external servers
- **Temporary Storage**: Links are stored in memory only and cleared when tabs close
- **Open Source**: Code is publicly available for security review

## Version History

- **v3.1**: UI/UX Improvements (Current)
  - Fixed link truncation - links now wrap fully instead of being cut off
  - Beautiful gradient background (purple theme) instead of plain white
  - Modern, user-friendly interface with hover effects
  - New transparent icons without white background
  - Enhanced visual feedback for copy operations
  - Improved readability and aesthetics
  
- **v3.0**: Manifest V3 support
  - Improved memory management and tab cleanup
  - Enhanced UI with copy functionality
  - Better error handling

## License

This project is open source. Please check the repository for license information.

## Contact

- **Repository**: [https://github.com/jrcramos/video_link_extractor](https://github.com/jrcramos/video_link_extractor)
- **Issues**: [GitHub Issues](https://github.com/jrcramos/video_link_extractor/issues)

---

Made with ❤️ for the open source community
