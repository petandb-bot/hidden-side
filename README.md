# HIDDEN SIDE v0.3.4

GPU image excavator for photographs and moving images.

## Recording

- **Photos**: RECORD captures the animated WebGL output as a silent video. Press STOP to finish, or recording stops automatically after 45 seconds.
- **Videos**: RECORD captures the processed video from its beginning, up to 45 seconds or the end of the source. Audio is not included.
- **Windows Chrome**: WebM/VP8 is preferred, with supported alternatives selected at runtime. **Safari**: MP4 is preferred when supported.
- The browser encodes in real time with `HTMLCanvasElement.captureStream()` and `MediaRecorder`. Output format, performance, and availability depend on the browser and GPU.
- The record control remains disabled if no file is loaded or recording APIs are unavailable. SAVE IMAGE exports a PNG in either input mode.

## Processing

Five modes remain: UNDER, NEGATIVE, RELIEF, SEEP, GHOST. Touch interaction and DEPTH / EROSION / DRIFT remain unchanged. The interface has been simplified to restrained typography, minimal boundaries, and a quieter action area.

## Runtime

- WebGL1 / GLSL ES 1.00, p5.js **1.11.13**.
- Load `index.html` via GitHub Pages or another HTTPS static host. For local tests on Windows, an HTTP development server is recommended.
- QUALITY adjusts preview resolution and recording resolution. Recording uses 24 fps (ECO/BALANCED) or 30 fps (FINE). A browser may encode fewer frames under load.
- GPU history uses two small reusable textures. The app does not upload user-selected media.
- The first launch requires a connection to load p5.js from the CDN.
- The new service worker cache is versioned. If an old installed version persists, fully reload the app or clear the site's cached data.

## Limits

Recording remains silent, real time, and at most 45 seconds. 4K output, lossless video, audio preservation, and offline frame-accurate conversion are not supported.

## v0.3.4 — Ghost trail

- GHOST exposes an additional TRAIL control beside the SOFT / DENSE selector.
- TRAIL changes the temporal decay of the existing GPU feedback buffer using elapsed-time exponential retention. No additional render targets or per-frame CPU readbacks are required.
- SOFT / DENSE preserve their v0.3.3 colors and spatial breakup. DENSE extends the decay slightly.
- Changing TRAIL preserves accumulated traces; switching modes, switching variants, or RESEED resets the feedback buffer.
- The redundant STILL label within the image stage is removed. Video timecodes and recording indicators remain.
- Further RESEED strategies and rare accidents are deferred to the next versions.
