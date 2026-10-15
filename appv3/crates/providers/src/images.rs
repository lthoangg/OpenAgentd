//! Image size policy shared by every provider: no image goes to a model
//! larger than [`MAX_IMAGE_EDGE`] px on either side. Anthropic rejects
//! bigger ones once a request carries more than 20 images, and the other
//! providers allow more, so one cap covers them all.
//!
//! Images that already fit cost one header read (no pixel decode). Oversized
//! ones are decoded once, resized with SIMD (`fast_image_resize`), and
//! re-encoded with fixed settings, so the same input always gives the same
//! bytes and the prompt cache stays stable across turns.

use crate::types::{ChatMessage, ContentBlock};
use base64::Engine;
use fast_image_resize as fr;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageFormat, ImageReader};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, LazyLock, Mutex};

/// Longest side, in pixels, of any image sent to a model.
pub const MAX_IMAGE_EDGE: u32 = 2000;
/// Header reads look at this many leading bytes (or base64 chars, a multiple
/// of 4) before falling back to the whole image.
const HEADER_PREFIX: usize = 65_536;
/// Budget of the in-memory cache of resized history images.
const CACHE_BUDGET_BYTES: usize = 64 << 20;
const JPEG_QUALITY: u8 = 85;
/// Resize kernel. Hamming costs the same as Bilinear (and about 20–40% less
/// than CatmullRom) and keeps text sharper than Bilinear; see `tests/image_bench.rs`.
pub const RESIZE_FILTER: fr::FilterType = fr::FilterType::Hamming;
/// PNG deflate level. Level 3 is ~1.1× the size of the default level at ~60%
/// of its time; `Fast` is 14× bigger, and the bytes are resent every turn.
pub const PNG_COMPRESSION: CompressionType = CompressionType::Level(3);
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// A resized image.
#[derive(Debug)]
pub struct Fitted {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
    pub from: (u32, u32),
    pub to: (u32, u32),
}

fn header_dims(bytes: &[u8]) -> Option<(u32, u32)> {
    ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?.into_dimensions().ok()
}

/// Image dimensions from the header only.
pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() > HEADER_PREFIX {
        if let Some(d) = header_dims(&bytes[..HEADER_PREFIX]) {
            return Some(d);
        }
    }
    header_dims(bytes)
}

/// Image dimensions of base64 data, decoding only a prefix when that holds
/// the header (a JPEG with a large EXIF block may need the whole image).
pub fn dimensions_b64(data: &str) -> Option<(u32, u32)> {
    if data.len() > HEADER_PREFIX {
        if let Some(d) = B64.decode(&data.as_bytes()[..HEADER_PREFIX]).ok().and_then(|p| header_dims(&p)) {
            return Some(d);
        }
    }
    dimensions(&B64.decode(data).ok()?)
}

fn fits(d: (u32, u32), max_edge: u32) -> bool {
    d.0 <= max_edge && d.1 <= max_edge
}

/// Media type of image bytes from their magic number, or `None` when the
/// bytes are not an image format providers accept.
pub fn sniff_media_type(bytes: &[u8]) -> Option<&'static str> {
    match image::guess_format(bytes).ok()? {
        ImageFormat::Png => Some("image/png"),
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::Gif => Some("image/gif"),
        ImageFormat::WebP => Some("image/webp"),
        _ => None,
    }
}

/// [`sniff_media_type`] for base64 data, decoding only the first bytes.
pub fn sniff_media_type_b64(data: &str) -> Option<&'static str> {
    let prefix = &data.as_bytes()[..data.len().min(64)];
    sniff_media_type(&B64.decode(prefix).ok()?)
}

fn target_size((w, h): (u32, u32), max_edge: u32) -> (u32, u32) {
    let scale = max_edge as f64 / w.max(h) as f64;
    let fit = |v: u32| ((v as f64 * scale).round() as u32).clamp(1, max_edge);
    (fit(w), fit(h))
}

fn resize(bytes: &[u8], max_edge: u32) -> Result<Fitted, String> {
    let reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?;
    let format = reader.format().ok_or("unknown image format")?;
    let img = reader.decode().map_err(|e| e.to_string())?;
    let from = (img.width(), img.height());
    let to = target_size(from, max_edge);
    let alpha = img.color().has_alpha();
    let (raw, pixel, color) = if alpha {
        (img.into_rgba8().into_raw(), fr::PixelType::U8x4, ExtendedColorType::Rgba8)
    } else {
        (img.into_rgb8().into_raw(), fr::PixelType::U8x3, ExtendedColorType::Rgb8)
    };
    let src = fr::images::Image::from_vec_u8(from.0, from.1, raw, pixel).map_err(|e| e.to_string())?;
    let mut dst = fr::images::Image::new(to.0, to.1, pixel);
    let opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(RESIZE_FILTER));
    fr::Resizer::new().resize(&src, &mut dst, &opts).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let media_type = if format == ImageFormat::Jpeg && !alpha {
        JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).write_image(dst.buffer(), to.0, to.1, color).map_err(|e| e.to_string())?;
        "image/jpeg"
    } else {
        // GIF (first frame) and WebP become PNG: the crate's WebP encoder is lossless only.
        PngEncoder::new_with_quality(&mut out, PNG_COMPRESSION, PngFilter::Adaptive).write_image(dst.buffer(), to.0, to.1, color).map_err(|e| e.to_string())?;
        "image/png"
    };
    Ok(Fitted { bytes: out, media_type, from, to })
}

/// Shrink raw image bytes so neither side exceeds `max_edge`. `None` when the
/// image already fits, is not an image, or cannot be decoded (fail-open).
pub fn fit_image_bytes(bytes: &[u8], max_edge: u32) -> Option<Fitted> {
    let d = dimensions(bytes)?;
    if fits(d, max_edge) {
        return None;
    }
    resize(bytes, max_edge).map_err(|e| tracing::warn!("image_resize_failed size={}x{} error={e}", d.0, d.1)).ok()
}

/// Base64 variant of [`fit_image_bytes`]: `(data, media_type)` when resized.
pub fn resize_base64_image(data: &str, max_edge: u32) -> Option<(String, String)> {
    let raw = B64.decode(data).ok()?;
    let f = fit_image_bytes(&raw, max_edge)?;
    Some((B64.encode(&f.bytes), f.media_type.to_string()))
}

// ── resize cache (history images replayed on every turn) ────────────────────

/// `(base64 data, media_type)`; the data is shared with every request that
/// replays the image.
type Resized = Arc<(Arc<str>, String)>;

struct Cache {
    map: HashMap<[u8; 32], (Resized, u64)>,
    bytes: usize,
    tick: u64,
    budget: usize,
}

impl Cache {
    fn new(budget: usize) -> Self {
        Self { map: HashMap::new(), bytes: 0, tick: 0, budget }
    }

    fn get(&mut self, key: &[u8; 32]) -> Option<Resized> {
        self.tick += 1;
        let tick = self.tick;
        self.map.get_mut(key).map(|(v, t)| {
            *t = tick;
            v.clone()
        })
    }

    fn put(&mut self, key: [u8; 32], value: Resized) {
        let size = value.0.len();
        if size > self.budget || self.map.contains_key(&key) {
            return;
        }
        while self.bytes + size > self.budget {
            let Some(oldest) = self.map.iter().min_by_key(|(_, (_, t))| *t).map(|(k, _)| *k) else { break };
            if let Some((v, _)) = self.map.remove(&oldest) {
                self.bytes -= v.0.len();
            }
        }
        self.tick += 1;
        self.bytes += size;
        self.map.insert(key, (value, self.tick));
    }
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::new(CACHE_BUDGET_BYTES)));

fn cache_key(data: &str, max_edge: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(max_edge.to_le_bytes());
    h.update(data.as_bytes());
    h.finalize().into()
}

/// [`resize_base64_image`] through a process-wide LRU cache keyed by the
/// sha256 of the input, so replayed history images resize once.
pub fn fit_base64_image(data: &str, max_edge: u32) -> Option<Resized> {
    let key = cache_key(data, max_edge);
    if let Some(hit) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Some(hit);
    }
    let (d, mt) = resize_base64_image(data, max_edge)?;
    let out: Resized = Arc::new((d.into(), mt));
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).put(key, out.clone());
    Some(out)
}

// ── async entry points ───────────────────────────────────────────────────────

fn oversized(b: &ContentBlock, max_edge: u32) -> bool {
    matches!(b, ContentBlock::ImageData { data, media_type } if media_type.starts_with("image/") && dimensions_b64(data).is_some_and(|d| !fits(d, max_edge)))
}

fn parts_mut(m: &mut ChatMessage) -> Option<&mut Vec<ContentBlock>> {
    match m {
        ChatMessage::User { parts, .. } | ChatMessage::Tool { parts, .. } => parts.as_mut(),
        _ => None,
    }
}

/// Resize the given `ImageData` blocks on the blocking pool, at most one per
/// core at a time (bounds peak memory). Fail-open: a block that cannot be
/// resized keeps its original data.
async fn fit_blocks(blocks: Vec<&mut ContentBlock>, cached: bool) -> usize {
    use futures::StreamExt;
    let mut jobs = Vec::with_capacity(blocks.len());
    let mut slots = Vec::with_capacity(blocks.len());
    for b in blocks {
        let ContentBlock::ImageData { data, media_type } = b else { continue };
        jobs.push(data.clone());
        slots.push((data, media_type));
    }
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    // Unordered so a slow core never stalls the queue; indices restore order.
    let mut results: Vec<_> = futures::stream::iter(jobs.into_iter().enumerate())
        .map(|(i, task)| async move {
            let r = tokio::task::spawn_blocking(move || {
                if cached {
                    fit_base64_image(&task, MAX_IMAGE_EDGE)
                } else {
                    resize_base64_image(&task, MAX_IMAGE_EDGE).map(|(d, mt)| Arc::new((d.into(), mt)))
                }
            })
            .await;
            (i, r)
        })
        .buffer_unordered(workers)
        .collect()
        .await;
    results.sort_by_key(|(i, _)| *i);
    let mut changed = 0;
    for ((data, media_type), (_, res)) in slots.into_iter().zip(results) {
        match res {
            Ok(Some(fit)) => {
                *data = fit.0.clone();
                *media_type = fit.1.clone();
                changed += 1;
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("image_resize_task_failed error={e}"),
        }
    }
    changed
}

/// Shrink oversized images in a fresh tool result. Returns how many changed.
pub async fn fit_tool_parts(parts: &mut [ContentBlock]) -> usize {
    let blocks: Vec<&mut ContentBlock> = parts.iter_mut().filter(|b| oversized(b, MAX_IMAGE_EDGE)).collect();
    if blocks.is_empty() {
        return 0;
    }
    fit_blocks(blocks, false).await
}

/// Shrink oversized images in an outgoing request (old history included),
/// and relabel images whose bytes are another format than their media type
/// says (providers reject the mismatch). Returns the messages, edited in
/// place, and how many images were resized.
pub async fn fit_request(mut messages: Vec<ChatMessage>) -> (Vec<ChatMessage>, usize) {
    for b in messages.iter_mut().filter_map(parts_mut).flat_map(|p| p.iter_mut()) {
        if let ContentBlock::ImageData { data, media_type } = b {
            if let Some(real) = media_type.starts_with("image/").then(|| sniff_media_type_b64(data)).flatten().filter(|real| media_type != real) {
                // Debug: a history image is relabelled again on every turn.
                tracing::debug!("image_media_type_corrected declared={media_type} actual={real}");
                *media_type = real.to_string();
            }
        }
    }
    let changed = {
        let blocks: Vec<&mut ContentBlock> = messages.iter_mut().filter_map(parts_mut).flat_map(|p| p.iter_mut()).filter(|b| oversized(b, MAX_IMAGE_EDGE)).collect();
        if blocks.is_empty() {
            0
        } else {
            fit_blocks(blocks, true).await
        }
    };
    (messages, changed)
}

/// Deterministic synthetic images for tests and benchmarks.
#[doc(hidden)]
pub mod fixtures {
    use image::{DynamicImage, ImageFormat, RgbImage};
    use std::io::Cursor;

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
    }

    /// UI-like: flat panels and dark "glyph" runs on text lines.
    pub fn screenshot(w: u32, h: u32) -> DynamicImage {
        let mut rng = Lcg(7);
        let mut img = RgbImage::from_pixel(w, h, image::Rgb([246, 246, 248]));
        for y in 0..h {
            for x in 0..(w / 6) {
                img.put_pixel(x, y, image::Rgb([232, 234, 238]));
            }
        }
        let mut y = 8;
        while y + 12 < h {
            let mut x = w / 6 + 16;
            while x + 7 < w {
                if !rng.next().is_multiple_of(5) {
                    for gy in y..y + 12 {
                        for gx in x..x + 6 {
                            img.put_pixel(gx, gy, image::Rgb([40, 40, 48]));
                        }
                    }
                }
                x += 9;
            }
            y += 22;
        }
        DynamicImage::ImageRgb8(img)
    }

    /// Photo-like: smooth gradients plus mild noise.
    pub fn photo(w: u32, h: u32) -> DynamicImage {
        let mut rng = Lcg(11);
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            let n = (rng.next() % 48) as i32 - 24;
            let c = |v: u32, m: u32| ((v * 255 / m.max(1)) as i32 + n).clamp(0, 255) as u8;
            image::Rgb([c(x, w), c(y, h), c(x + y, w + h)])
        }))
    }

    /// Incompressible noise (worst case).
    pub fn noise(w: u32, h: u32) -> DynamicImage {
        let mut rng = Lcg(13);
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |_, _| {
            let v = rng.next();
            image::Rgb([v as u8, (v >> 8) as u8, (v >> 16) as u8])
        }))
    }

    pub fn encode(img: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, format).expect("encode fixture");
        out.into_inner()
    }

    pub fn png(w: u32, h: u32) -> Vec<u8> {
        encode(&screenshot(w, h), ImageFormat::Png)
    }

    pub fn jpeg(w: u32, h: u32) -> Vec<u8> {
        encode(&photo(w, h), ImageFormat::Jpeg)
    }

    pub fn b64(bytes: &[u8]) -> String {
        use base64::Engine;
        super::B64.encode(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::MessageMeta;

    fn b64(bytes: &[u8]) -> String {
        B64.encode(bytes)
    }

    fn image_part(bytes: &[u8], mt: &str) -> ContentBlock {
        ContentBlock::ImageData { data: b64(bytes).into(), media_type: mt.into() }
    }

    fn decoded_dims(b: &ContentBlock) -> (u32, u32) {
        let ContentBlock::ImageData { data, .. } = b else { panic!("not image") };
        dimensions_b64(data).unwrap()
    }

    #[test]
    fn dimensions_from_header_for_each_format() {
        let img = fixtures::screenshot(64, 40);
        for f in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Gif, ImageFormat::WebP] {
            let bytes = fixtures::encode(&img, f);
            assert_eq!(dimensions(&bytes), Some((64, 40)), "{f:?}");
            assert_eq!(dimensions_b64(&b64(&bytes)), Some((64, 40)), "{f:?}");
        }
        assert_eq!(dimensions(b"not an image"), None);
        assert_eq!(dimensions_b64("%%%"), None);
    }

    #[test]
    fn jpeg_with_large_app_segment_falls_back_to_full_read() {
        let jpeg = fixtures::jpeg(80, 30);
        let mut padded = jpeg[..2].to_vec();
        for _ in 0..2 {
            let payload = vec![0u8; 50_000];
            padded.extend([0xFF, 0xE1]);
            padded.extend(((payload.len() + 2) as u16).to_be_bytes());
            padded.extend(payload);
        }
        padded.extend(&jpeg[2..]);
        assert!(padded.len() > HEADER_PREFIX && header_dims(&padded[..HEADER_PREFIX]).is_none());
        assert_eq!(dimensions(&padded), Some((80, 30)));
        assert_eq!(dimensions_b64(&b64(&padded)), Some((80, 30)));
    }

    #[test]
    fn oversized_png_shrinks_to_max_edge_and_keeps_aspect() {
        let f = fit_image_bytes(&fixtures::png(3000, 1000), MAX_IMAGE_EDGE).unwrap();
        assert_eq!((f.media_type, f.from, f.to), ("image/png", (3000, 1000), (2000, 667)));
        assert_eq!(dimensions(&f.bytes), Some((2000, 667)));
    }

    #[test]
    fn image_that_fits_or_is_not_an_image_is_left_alone() {
        assert!(fit_image_bytes(&fixtures::png(1200, 800), MAX_IMAGE_EDGE).is_none());
        assert!(fit_image_bytes(b"%PDF-1.7 garbage", MAX_IMAGE_EDGE).is_none());
        assert!(resize_base64_image("not base64!", MAX_IMAGE_EDGE).is_none());
    }

    #[test]
    fn jpeg_stays_jpeg_and_tall_images_fit_too() {
        let f = fit_image_bytes(&fixtures::jpeg(1100, 2200), MAX_IMAGE_EDGE).unwrap();
        assert_eq!((f.media_type, f.to), ("image/jpeg", (1000, 2000)));
    }

    #[test]
    fn webp_and_gif_become_png() {
        let img = fixtures::screenshot(2100, 300);
        for f in [ImageFormat::WebP, ImageFormat::Gif] {
            let out = fit_image_bytes(&fixtures::encode(&img, f), MAX_IMAGE_EDGE).unwrap();
            assert_eq!((out.media_type, out.to), ("image/png", (2000, 286)), "{f:?}");
        }
    }

    #[test]
    fn resizing_is_deterministic() {
        let src = b64(&fixtures::png(2400, 600));
        assert_eq!(resize_base64_image(&src, MAX_IMAGE_EDGE), resize_base64_image(&src, MAX_IMAGE_EDGE));
    }

    #[test]
    fn cache_returns_the_same_result_and_evicts_oldest() {
        let src = b64(&fixtures::png(2300, 500));
        let a = fit_base64_image(&src, MAX_IMAGE_EDGE).unwrap();
        let b = fit_base64_image(&src, MAX_IMAGE_EDGE).unwrap();
        assert!(Arc::ptr_eq(&a, &b));

        let mut c = Cache::new(10);
        let v = |s: &str| Arc::new((Arc::<str>::from(s), "image/png".to_string()));
        c.put([1; 32], v("aaaa"));
        c.put([2; 32], v("bbbb"));
        assert!(c.get(&[1; 32]).is_some()); // 1 is now the most recent
        c.put([3; 32], v("cccc"));
        assert!(c.get(&[2; 32]).is_none());
        assert!(c.get(&[1; 32]).is_some() && c.get(&[3; 32]).is_some());
        assert!(c.bytes <= 10);
        c.put([4; 32], v("this is larger than the budget"));
        assert!(c.get(&[4; 32]).is_none());
    }

    #[tokio::test]
    async fn fit_request_changes_only_oversized_images() {
        let small = image_part(&fixtures::png(300, 200), "image/png");
        let big = image_part(&fixtures::png(2600, 1200), "image/png");
        let pdf = image_part(b"%PDF-1.7", "application/pdf");
        let messages = vec![
            ChatMessage::User { content: Some("hi".into()), parts: Some(vec![ContentBlock::text("hi"), small.clone()]), meta: MessageMeta::default() },
            ChatMessage::Tool {
                content: Some("[Image: a.png]".into()),
                tool_call_id: "c1".into(),
                name: Some("read".into()),
                parts: Some(vec![big, pdf.clone()]),
                meta: MessageMeta::default(),
            },
            ChatMessage::assistant("ok"),
        ];
        let (out, n) = fit_request(messages.clone()).await;
        assert_eq!(n, 1);
        let ChatMessage::Tool { parts: Some(p), .. } = &out[1] else { panic!() };
        assert_eq!(decoded_dims(&p[0]), (2000, 923));
        assert_eq!(p[1], pdf);
        assert_eq!(out[0], messages[0]);
        assert_eq!(out[2], messages[2]);

        let (again, n) = fit_request(out.clone()).await;
        assert_eq!((n, again), (0, out));
    }

    #[tokio::test]
    async fn fit_tool_parts_resizes_and_keeps_text() {
        let mut parts = vec![ContentBlock::text("[shot]"), image_part(&fixtures::png(2400, 1600), "image/png"), image_part(&fixtures::png(100, 100), "image/png")];
        let small = parts[2].clone();
        assert_eq!(fit_tool_parts(&mut parts).await, 1);
        assert_eq!(parts[0], ContentBlock::text("[shot]"));
        assert_eq!(decoded_dims(&parts[1]), (2000, 1333));
        assert_eq!(parts[2], small);
    }

    #[test]
    fn sniffs_the_media_type_from_the_bytes() {
        let img = fixtures::screenshot(16, 16);
        for (f, mt) in [(ImageFormat::Png, "image/png"), (ImageFormat::Jpeg, "image/jpeg"), (ImageFormat::Gif, "image/gif"), (ImageFormat::WebP, "image/webp")] {
            let bytes = fixtures::encode(&img, f);
            assert_eq!(sniff_media_type(&bytes), Some(mt), "{f:?}");
            assert_eq!(sniff_media_type_b64(&b64(&bytes)), Some(mt), "{f:?}");
        }
        assert_eq!(sniff_media_type(b"%PDF-1.7"), None);
        assert_eq!(sniff_media_type_b64("not base64!"), None);
    }

    /// A `.png` file holding JPEG bytes (e.g. `sips … --out x.png` without
    /// `-s format png`) is rejected by Anthropic, and stays in the history.
    #[tokio::test]
    async fn fit_request_relabels_an_image_whose_bytes_are_another_format() {
        let jpeg = fixtures::jpeg(120, 80);
        let pdf = image_part(b"%PDF-1.7", "application/pdf");
        let messages = vec![ChatMessage::Tool {
            content: Some("[Image: shot.png]".into()),
            tool_call_id: "c1".into(),
            name: Some("read".into()),
            parts: Some(vec![ContentBlock::text("[Image: shot.png]"), image_part(&jpeg, "image/png"), pdf.clone()]),
            meta: MessageMeta::default(),
        }];
        let (out, _) = fit_request(messages).await;
        let ChatMessage::Tool { parts: Some(p), .. } = &out[0] else { panic!() };
        assert_eq!(p[1], image_part(&jpeg, "image/jpeg"));
        assert_eq!(p[2], pdf);
    }
}
