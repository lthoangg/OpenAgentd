//! `generate_image` — create or edit an image in the session workspace.

use super::backends::{self, Named, Overrides};
use super::{config_path, get_section, load_input_image, opt_literal, opt_str_list, sanitise_filename, MediaObs, MediaSection};
use crate::args::Args;
use crate::{Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::Value;

const SIZES: [&str; 4] = ["auto", "1024x1024", "1536x1024", "1024x1536"];
const FORMATS: [&str; 3] = ["png", "jpeg", "webp"];
const ASPECTS: [&str; 5] = ["1:1", "3:4", "4:3", "9:16", "16:9"];
const RESOLUTIONS: [&str; 4] = ["0.5K", "1K", "2K", "4K"];
const PROVIDERS: [&str; 3] = ["codex", "googlegenai", "openai"];

pub struct GenerateImageTool;

async fn call_backend(cfg: &MediaSection, prompt: &str, images: Option<&[Named]>, overrides: Option<&Overrides>) -> Result<Vec<u8>, String> {
    match (cfg.provider.as_str(), images) {
        ("openai", None) => backends::generate_openai(cfg, prompt, overrides).await,
        ("openai", Some(i)) => backends::edit_openai(cfg, prompt, i, overrides).await,
        ("codex", None) => backends::generate_codex(cfg, prompt, overrides).await,
        ("codex", Some(i)) => backends::edit_codex(cfg, prompt, i, overrides).await,
        (_, None) => backends::generate_googlegenai(cfg, prompt, overrides).await,
        (_, Some(i)) => backends::edit_googlegenai(cfg, prompt, i, overrides).await,
    }
}

#[async_trait]
impl Tool for GenerateImageTool {
    fn name(&self) -> &str {
        "generate_image"
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("generate_image", &args);
        let prompt = a.req_str(&["prompt"]);
        let filename = a.opt_str(&["filename"]);
        let images = opt_str_list(&mut a, "images");
        let size = opt_literal(&mut a, "size", &SIZES);
        let output_format = opt_literal(&mut a, "output_format", &FORMATS);
        let aspect_ratio = opt_literal(&mut a, "aspect_ratio", &ASPECTS);
        let image_size = opt_literal(&mut a, "image_size", &RESOLUTIONS);
        a.finish()?;
        let obs = MediaObs::start("image");
        obs.span.set_attr("image.prompt_length", prompt.chars().count());
        obs.span.set_attr("image.input_count", images.as_ref().map(|i| i.len()).unwrap_or(0));
        let res = generate(ctx, &obs, prompt, filename, images, size, output_format, aspect_ratio, image_size).await;
        obs.finish(res)
    }
}

#[allow(clippy::too_many_arguments)]
async fn generate(
    ctx: &ToolContext,
    obs: &MediaObs,
    prompt: String,
    filename: Option<String>,
    images: Option<Vec<String>>,
    size: Option<String>,
    output_format: Option<String>,
    aspect_ratio: Option<String>,
    image_size: Option<String>,
) -> ToolResult {
    let fail = |error_type: &str, msg: &str| {
        tracing::debug!("generate_image_failed error_type={} message={}", error_type, super::take_chars(msg, 200));
        obs.fail(error_type, msg)
    };

    let Some(cfg) = get_section("image") else {
        return fail("configuration", &format!("image generation is not configured. Add an `image` section to {}.", config_path().display()));
    };
    obs.span.set_attr("gen_ai.provider.name", cfg.provider.as_str());
    obs.span.set_attr("gen_ai.request.model", cfg.model.as_str());
    obs.span.set_name(format!("generate_image {}:{}", cfg.provider, cfg.model));
    if !PROVIDERS.contains(&cfg.provider.as_str()) {
        return fail("unknown_provider", &format!("provider '{}' is not supported for image generation. Supported providers: {}.", cfg.provider, PROVIDERS.join(", ")));
    }
    let mut overrides: Overrides = vec![];
    for (k, v) in [("size", &size), ("output_format", &output_format), ("aspect_ratio", &aspect_ratio), ("image_size", &image_size)] {
        if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
            overrides.push((k.into(), v.clone()));
            obs.span.set_attr(&format!("image.{k}"), v.as_str());
        }
    }
    let images = images.filter(|i| !i.is_empty());
    let mode = if images.is_some() { "edit" } else { "generate" };
    obs.span.set_attr("image.mode", mode);
    let ov = (!overrides.is_empty()).then_some(&overrides);
    let result = match &images {
        Some(paths) => {
            let mut loaded = vec![];
            for p in paths {
                match load_input_image(&ctx.denied, p, "input image is empty; specify a non-empty workspace path.") {
                    Ok(l) => loaded.push(l),
                    Err(e) => return fail("sandbox", e.strip_prefix("Error: ").unwrap_or(&e)),
                }
            }
            call_backend(&cfg, &prompt, Some(&loaded), ov).await
        }
        None => call_backend(&cfg, &prompt, None, ov).await,
    };
    let bytes = match result {
        Ok(b) => b,
        Err(e) => return fail("backend", e.strip_prefix("Error: ").unwrap_or(&e)),
    };
    let chosen = output_format.clone().or_else(|| cfg.extra_str("output_format").map(String::from));
    let ext = chosen.filter(|c| FORMATS.contains(&c.as_str())).unwrap_or_else(|| "png".into());
    let name = sanitise_filename(filename.as_deref(), "image", &ext);
    let resolved = ctx.denied.validate_path(&name)?;
    std::fs::write(&resolved, &bytes)?;
    let rel = ctx.denied.display_path(&resolved);
    tracing::info!(
        "generate_image_saved path={} bytes={} provider={} model={} mode={} inputs={}",
        resolved.display(),
        bytes.len(),
        cfg.provider,
        cfg.model,
        mode,
        images.as_ref().map(|i| i.len()).unwrap_or(0)
    );
    obs.ok(bytes.len());
    Ok(ToolOutput::text(format!("![{prompt}]({rel})")))
}
