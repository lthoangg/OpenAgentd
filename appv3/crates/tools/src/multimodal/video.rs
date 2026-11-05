//! `generate_video` — create a Veo clip in the session workspace.

use super::backends::{self, Overrides, VideoInputs};
use super::{config_path, get_section, load_input_image, opt_literal, opt_str_list, sanitise_filename, take_chars, MediaObs};
use crate::args::Args;
use crate::{Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::Value;

const ASPECTS: [&str; 2] = ["16:9", "9:16"];
const RESOLUTIONS: [&str; 3] = ["720p", "1080p", "4k"];
const DURATIONS: [&str; 3] = ["4", "6", "8"];
const FILES_API_BASE: &str = "https://generativelanguage.googleapis.com/";
const MAX_REFS: usize = 3;
const EMPTY_PATH: &str = "image path must be a non-empty workspace string.";

pub struct GenerateVideoTool;

#[async_trait]
impl Tool for GenerateVideoTool {
    fn name(&self) -> &str {
        "generate_video"
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("generate_video", &args);
        let prompt = a.req_str(&["prompt"]);
        let filename = a.opt_str(&["filename"]);
        let first_frame = a.opt_str(&["first_frame"]);
        let last_frame = a.opt_str(&["last_frame"]);
        let reference_images = opt_str_list(&mut a, "reference_images");
        let aspect_ratio = opt_literal(&mut a, "aspect_ratio", &ASPECTS);
        let resolution = opt_literal(&mut a, "resolution", &RESOLUTIONS);
        let duration_seconds = opt_literal(&mut a, "duration_seconds", &DURATIONS);
        let extend_video = a.opt_str(&["extend_video"]);
        a.finish()?;
        let obs = MediaObs::start("video");
        obs.span.set_attr("video.prompt_length", prompt.chars().count());
        obs.span.set_attr("video.has_first_frame", first_frame.is_some());
        obs.span.set_attr("video.reference_image_count", reference_images.as_ref().map(|r| r.len()).unwrap_or(0));
        obs.span.set_attr("video.has_last_frame", last_frame.is_some());
        obs.span.set_attr("video.has_extend_video", extend_video.is_some());
        let res = generate(ctx, &obs, prompt, filename, first_frame, last_frame, reference_images, aspect_ratio, resolution, duration_seconds, extend_video).await;
        obs.finish(res)
    }
}

#[allow(clippy::too_many_arguments)]
async fn generate(
    ctx: &ToolContext,
    obs: &MediaObs,
    prompt: String,
    filename: Option<String>,
    first_frame: Option<String>,
    last_frame: Option<String>,
    reference_images: Option<Vec<String>>,
    aspect_ratio: Option<String>,
    resolution: Option<String>,
    duration_seconds: Option<String>,
    extend_video: Option<String>,
) -> ToolResult {
    let fail = |error_type: &str, msg: &str| {
        tracing::debug!("generate_video_failed error_type={} message={}", error_type, take_chars(msg, 200));
        obs.fail(error_type, msg)
    };

    let Some(cfg) = get_section("video") else {
        return fail("configuration", &format!("video generation is not configured. Add a `video` section to {}.", config_path().display()));
    };
    obs.span.set_attr("gen_ai.provider.name", cfg.provider.as_str());
    obs.span.set_attr("gen_ai.request.model", cfg.model.as_str());
    obs.span.set_name(format!("generate_video {}:{}", cfg.provider, cfg.model));
    if cfg.provider != "googlegenai" {
        return fail("unknown_provider", &format!("provider '{}' is not supported for video generation. Supported providers: googlegenai.", cfg.provider));
    }
    if last_frame.is_some() && first_frame.is_none() {
        return fail("validation", "`last_frame` requires `first_frame` to also be set.");
    }
    if let Some(r) = &reference_images {
        if r.is_empty() {
            return fail("validation", "`reference_images` must be a non-empty list (or omitted).");
        }
        if r.len() > MAX_REFS {
            return fail("validation", &format!("`reference_images` supports up to {MAX_REFS} entries ({} provided).", r.len()));
        }
    }
    if reference_images.is_some() && last_frame.is_some() {
        return fail("validation", "`reference_images` and `last_frame` are mutually exclusive on Veo.");
    }
    if let Some(ext) = &extend_video {
        let truthy = |s: &Option<String>| s.as_deref().map(|x| !x.is_empty()).unwrap_or(false);
        if truthy(&first_frame) || truthy(&last_frame) || reference_images.as_ref().map(|r| !r.is_empty()).unwrap_or(false) {
            return fail("validation", "`extend_video` is mutually exclusive with `first_frame`, `last_frame`, and `reference_images`.");
        }
        if !ext.starts_with(FILES_API_BASE) {
            return fail("validation", &format!("`extend_video` must be a Files API URI starting with '{FILES_API_BASE}' (got '{}').", take_chars(ext, 80)));
        }
        if let Some(ar) = aspect_ratio.as_deref().filter(|s| !s.is_empty() && *s != "16:9") {
            return fail("validation", &format!("video extension only supports 16:9 aspect ratio (got '{ar}')."));
        }
        if let Some(r) = resolution.as_deref().filter(|s| !s.is_empty() && *s != "720p") {
            return fail("validation", &format!("video extension only supports 720p resolution (got '{r}')."));
        }
        if let Some(d) = duration_seconds.as_deref().filter(|s| !s.is_empty() && *s != "8") {
            return fail("validation", &format!("video extension requires duration_seconds='8' (got '{d}')."));
        }
    }
    let mode = if extend_video.is_some() {
        "extension"
    } else if reference_images.as_ref().map(|r| !r.is_empty()).unwrap_or(false) {
        "reference"
    } else if last_frame.is_some() {
        "interpolation"
    } else if first_frame.is_some() {
        "image"
    } else {
        "text"
    };
    obs.span.set_attr("video.mode", mode);
    let mut overrides: Overrides = vec![];
    for (k, v) in [("aspect_ratio", &aspect_ratio), ("resolution", &resolution), ("duration_seconds", &duration_seconds)] {
        if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
            overrides.push((k.into(), v.clone()));
            obs.span.set_attr(&format!("video.{k}"), v.as_str());
        }
    }
    let load = |p: &str| load_input_image(&ctx.denied, p, EMPTY_PATH);
    let first = match first_frame.as_deref().map(load).transpose() {
        Ok(v) => v,
        Err(e) => return fail("sandbox", e.strip_prefix("Error: ").unwrap_or(&e)),
    };
    let last = match last_frame.as_deref().map(load).transpose() {
        Ok(v) => v,
        Err(e) => return fail("sandbox", e.strip_prefix("Error: ").unwrap_or(&e)),
    };
    let mut refs = None;
    if let Some(r) = reference_images.as_ref().filter(|r| !r.is_empty()) {
        let mut out = vec![];
        for p in r {
            match load(p) {
                Ok(l) => out.push(l),
                Err(e) => return fail("sandbox", e.strip_prefix("Error: ").unwrap_or(&e)),
            }
        }
        refs = Some(out);
    }
    let inputs = VideoInputs { image: first.as_ref(), last_frame: last.as_ref(), reference_images: refs.as_deref(), extend_video: extend_video.as_deref() };
    let ov = (!overrides.is_empty()).then_some(&overrides);
    let (mp4, uri) = match backends::generate_video_googlegenai(&cfg, &prompt, inputs, ov).await {
        Ok(r) => r,
        Err(e) => return fail("backend", e.strip_prefix("Error: ").unwrap_or(&e)),
    };
    let name = sanitise_filename(filename.as_deref(), "video", "mp4");
    let resolved = ctx.denied.validate_path(&name)?;
    std::fs::write(&resolved, &mp4)?;
    let rel = ctx.denied.display_path(&resolved);
    tracing::info!(
        "generate_video_saved path={} bytes={} provider={} model={} mode={} refs={} has_last_frame={} extend_uri={}",
        resolved.display(),
        mp4.len(),
        cfg.provider,
        cfg.model,
        mode,
        refs.as_ref().map(|r| r.len()).unwrap_or(0),
        last_frame.is_some(),
        extend_video.is_some()
    );
    obs.ok(mp4.len());
    Ok(ToolOutput::text(format!("![{prompt}]({rel})\n\nTo extend this video, pass `extend_video=\"{uri}\"`.")))
}
