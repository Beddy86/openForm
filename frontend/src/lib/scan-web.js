// Browser-side QR decoding for the gym check-in — the PWA half of lib/scan.js. The app build
// hands scanning to ML Kit; here in a browser tab (installed PWA on a phone, most often) we do
// it ourselves: draw the source — an uploaded photo or a live <video> frame — onto an offscreen
// canvas and decode the pixels.
//
// Two decoders, tried in order:
//   1. BarcodeDetector — the browser's own (Chrome/Edge on Android, Samsung Internet). Native
//      speed and quality when it exists; asked for QR only.
//   2. jsQR (Apache-2.0, see NOTICE.md) — pure JS, works everywhere including iOS Safari, which
//      has no BarcodeDetector. Loaded with a dynamic import so it only ships when someone scans.
//
// decodeImageData is the pure core (pixels in, string out) and is what the unit test exercises;
// decodeSource wraps it with the canvas plumbing the browser paths need.
import { normalizeFmt } from './qr.js'

let _jsqr = null
async function loadJsQr() {
  if (!_jsqr) _jsqr = (await import('jsqr')).default
  return _jsqr
}

let _detector = null
function nativeDetector() {
  if (_detector !== null) return _detector
  try {
    _detector = (typeof BarcodeDetector === 'function') ? new BarcodeDetector({ formats: ['qr_code'] }) : false
  } catch (e) { _detector = false }
  return _detector
}

// { data, width, height } (an ImageData or anything shaped like one) → { value, fmt } | null.
// jsQR only; the native detector wants a drawable, not raw pixels, so it lives in decodeSource.
export async function decodeImageData(img) {
  if (!img || !img.data || !img.width || !img.height) return null
  const jsQR = await loadJsQr()
  const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })
  return hit && hit.data ? { value: hit.data, fmt: 'qrcode' } : null
}

// Decode from anything drawImage accepts: <video>, <img>, ImageBitmap, canvas. The source is
// scaled down to at most MAX px on its long edge — plenty for a QR, and it keeps jsQR fast enough
// to run on every few video frames on a phone. Reuses one canvas across calls.
const MAX = 800
let _canvas = null
export async function decodeSource(source) {
  const sw = source.videoWidth || source.naturalWidth || source.width || 0
  const sh = source.videoHeight || source.naturalHeight || source.height || 0
  if (!sw || !sh) return null
  const k = Math.min(1, MAX / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k))
  if (!_canvas) _canvas = document.createElement('canvas')
  _canvas.width = w; _canvas.height = h
  const ctx = _canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)

  const det = nativeDetector()
  if (det) {
    try {
      const found = await det.detect(_canvas)
      const b = found && found.find(x => x.rawValue)
      if (b) return { value: b.rawValue, fmt: normalizeFmt(b.format) || 'qrcode' }
    } catch (e) { /* fall through to jsQR */ }
  }
  return decodeImageData(ctx.getImageData(0, 0, w, h))
}

// A picked File → { value, fmt } | null. createImageBitmap honours EXIF orientation where the
// browser supports it, which matters for photos of a card taken in portrait.
export async function importCodeFromImageWeb(file) {
  if (!file) return null
  let bmp
  if (typeof createImageBitmap === 'function') {
    bmp = await createImageBitmap(file)
  } else {
    bmp = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('bad image'))
      img.src = URL.createObjectURL(file)
    })
  }
  try { return await decodeSource(bmp) } finally { if (bmp.close) bmp.close() }
}

// Live camera scan for the browser build (installed PWA on iOS/Android). The native app hands this
// to ML Kit; a browser has no scanner UI, so we show our own full-screen overlay: getUserMedia →
// <video> → decodeSource() every ~200 ms until a QR is found or the user cancels.
// Resolves { value, fmt } | null (cancelled). Rejects when the camera can't be opened, so callers
// show their "camera not available" message.
export async function scanCodeWeb() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new Error('camera-unsupported')
  // iOS needs this call to come out of a tap handler — it does, the caller is a button's onClick.
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
  return new Promise(resolve => {
    let done = false, timer = null
    const root = document.createElement('div')
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', 'QR-Code scannen')
    root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;'
    const video = document.createElement('video')
    video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.autoplay = true
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;'
    const hint = document.createElement('div')
    hint.textContent = 'QR-Code in den Bildausschnitt halten'
    hint.style.cssText = 'position:absolute;top:max(env(safe-area-inset-top),20px);left:0;right:0;text-align:center;color:#fff;font:600 16px -apple-system,system-ui,sans-serif;text-shadow:0 1px 4px #000;'
    const frame = document.createElement('div')
    frame.style.cssText = 'position:absolute;width:62vmin;height:62vmin;border:3px solid #30d158;border-radius:22px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none;'
    const close = document.createElement('button')
    close.textContent = 'Abbrechen'
    close.style.cssText = 'position:absolute;bottom:max(env(safe-area-inset-bottom),28px);padding:14px 34px;border:0;border-radius:999px;background:#fff;color:#000;font:600 17px -apple-system,system-ui,sans-serif;'
    root.append(video, frame, hint, close)
    document.body.appendChild(root)

    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      stream.getTracks().forEach(t => t.stop())
      root.remove()
      resolve(value)
    }
    close.onclick = () => finish(null)
    video.srcObject = stream
    video.play().catch(() => {})
    const tick = async () => {
      if (done) return
      try {
        if (video.readyState >= 2) {
          const hit = await decodeSource(video)
          if (hit && hit.value) { finish(hit); return }
        }
      } catch (e) { /* try the next frame */ }
      timer = setTimeout(tick, 200)
    }
    tick()
  })
}
