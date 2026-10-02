//! Keyboard reader thread. It can pause so the app can read a terminal reply
//! (the cursor position) that the reader would otherwise swallow.

use crossterm::event::{self, Event};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub struct Input {
    paused: Arc<AtomicBool>,
    idle: Arc<AtomicBool>,
}

impl Input {
    /// Read events on a thread and pass each to `send` until it returns false.
    pub fn spawn(send: impl Fn(Event) -> bool + Send + 'static) -> Self {
        let paused = Arc::new(AtomicBool::new(false));
        let idle = Arc::new(AtomicBool::new(false));
        let (p, i) = (paused.clone(), idle.clone());
        std::thread::spawn(move || loop {
            if p.load(Ordering::SeqCst) {
                i.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            i.store(false, Ordering::SeqCst);
            match event::poll(Duration::from_millis(30)) {
                Ok(true) => match event::read() {
                    Ok(ev) => {
                        if !send(ev) {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                Ok(false) => {}
                Err(_) => break,
            }
        });
        Self { paused, idle }
    }

    /// Run `f` while the reader thread is not reading.
    pub fn paused<T>(&self, f: impl FnOnce() -> T) -> T {
        self.paused.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_millis(300);
        while !self.idle.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(2));
        }
        let out = f();
        self.paused.store(false, Ordering::SeqCst);
        out
    }
}
