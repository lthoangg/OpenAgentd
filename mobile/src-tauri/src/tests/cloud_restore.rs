//! The stored account at launch, through `cloud_status` as the page calls
//! it, on the phone and fake cloud of `cloud_e2e_tests`.

use std::sync::mpsc;

use super::*;
use crate::cloud_e2e_tests::{fake_cloud, init_phone, signed_in_with_a_computer, SERIAL};

/// The next read of the stored account waits until the other end is
/// dropped, as a key store that is slow when the app starts.
static HOLD_NEXT_READ: Mutex<Option<mpsc::Receiver<()>>> = Mutex::new(None);

pub(super) fn hold_this_read() {
    let held = HOLD_NEXT_READ
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(held) = held {
        let _ = held.recv();
    }
}

/// The next read waits until what this returns is dropped.
fn slow_key_store() -> mpsc::Sender<()> {
    let (release, held) = mpsc::channel();
    *HOLD_NEXT_READ.lock().unwrap() = Some(held);
    release
}

/// The app starts again on the account it stored (`PHONE` is one per
/// process), from the point where `init` has built the phone.
async fn relaunch() {
    let p = phone().unwrap();
    *p.member.lock().await = None;
    set_status(guest(None));
    p.restored.send_replace(false);
    tauri::async_runtime::spawn(run());
}

async fn fake_account() -> fake_cloud::Fake {
    let fake = fake_cloud::Fake::new();
    let base = fake.serve().await;
    std::env::set_var("OPENAGENTD_CLOUD_API", &base);
    std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
    init_phone();
    signed_in_with_a_computer(&fake, &base).await;
    fake
}

#[test]
fn a_phone_with_a_stored_account_says_so_from_the_first_status_read() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let _fake = fake_account().await;

        let release = slow_key_store();
        relaunch().await;
        // The page asks at once; the keys are read while it waits.
        let (status, ()) = tokio::join!(cloud_status(), async move { drop(release) });
        assert!(
            matches!(status, Status::Connected { signer: true, .. }),
            "a tap that launched the app is dropped on a guest answer: {status:?}"
        );

        cloud_sign_out().await.unwrap();
    });
}

#[test]
fn a_phone_without_an_account_is_a_guest_as_soon_as_its_key_store_answers() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        init_phone();
        relaunch().await;
        assert!(
            finished(Duration::from_secs(60)).await,
            "nothing stored still ends the wait"
        );
        assert!(matches!(cloud_status().await, Status::Guest { .. }));
    });
}

#[test]
fn a_key_store_that_does_not_answer_holds_the_status_back_only_for_a_while() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let _fake = fake_account().await;

        let release = slow_key_store();
        relaunch().await;
        assert!(
            !finished(Duration::from_millis(20)).await,
            "the wait ends at its limit"
        );

        // The key store answers later: the account is there after all.
        drop(release);
        assert!(finished(Duration::from_secs(60)).await);
        let status = cloud_status().await;
        assert!(
            matches!(status, Status::Connected { signer: true, .. }),
            "{status:?}"
        );

        cloud_sign_out().await.unwrap();
    });
}
