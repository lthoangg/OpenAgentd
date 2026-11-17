//! Stored credentials never leave a tool call. A call's live output is masked
//! before the progress record and every hook's sink see it, and its result is
//! masked before any hook, the transcript or telemetry does.

use appv3_core::secret_mask::{self, Masker, StreamMask};
use appv3_tools::OutputSink;
use std::sync::{Arc, Mutex};

/// Masks one call's live output. A value split across two chunks is held back
/// until it is whole, so [`LiveMask::finish`] must run when the call ends.
pub(crate) struct LiveMask {
    mask: Arc<Mutex<StreamMask>>,
    sink: Option<OutputSink>,
}

impl LiveMask {
    /// Route `output` through the current stored credentials' mask.
    pub(crate) fn wrap(output: &mut Option<OutputSink>) -> Self {
        Self::wrap_with(output, secret_mask::current())
    }

    fn wrap_with(output: &mut Option<OutputSink>, masker: Arc<Masker>) -> Self {
        let mask = Arc::new(Mutex::new(StreamMask::new(masker)));
        let sink = output.take();
        if let Some(inner) = sink.clone() {
            let mask = mask.clone();
            *output = Some(Arc::new(move |text: String| {
                let shown = mask.lock().unwrap().push(&text);
                if !shown.is_empty() {
                    inner(shown);
                }
            }));
        }
        Self { mask, sink }
    }

    /// Send what was held back.
    pub(crate) fn finish(&self) {
        let rest = self.mask.lock().unwrap().finish();
        if let (Some(sink), false) = (&self.sink, rest.is_empty()) {
            sink(rest);
        }
    }
}

/// `text` with every stored credential replaced by `[secret NAME]`.
pub(crate) fn masked(text: String) -> String {
    match secret_mask::mask(&text) {
        std::borrow::Cow::Owned(m) => m,
        std::borrow::Cow::Borrowed(_) => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_split_across_chunks_reaches_the_sink_masked() {
        let seen = Arc::new(Mutex::new(String::new()));
        let record = seen.clone();
        let mut output: Option<OutputSink> = Some(Arc::new(move |t: String| record.lock().unwrap().push_str(&t)));
        let masker = Arc::new(Masker::new([("STRIPE_SECRET_KEY".to_string(), "sk_test_live_split_42".to_string())]));
        let live = LiveMask::wrap_with(&mut output, masker);
        let sink = output.expect("the sink stays wired");
        sink("key=sk_test_li".into());
        sink("ve_split_42 done\n".into());
        live.finish();
        let shown = seen.lock().unwrap().clone();
        assert!(!shown.contains("sk_test_live_split_42"), "{shown}");
        assert!(shown.contains("[secret STRIPE_SECRET_KEY]") && shown.ends_with("done\n"), "{shown}");
    }

    #[test]
    fn no_sink_stays_no_sink() {
        let mut output: Option<OutputSink> = None;
        let live = LiveMask::wrap_with(&mut output, Arc::new(Masker::new([])));
        assert!(output.is_none());
        live.finish();
    }
}
