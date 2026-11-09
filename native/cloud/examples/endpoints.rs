//! Prints the hosts this build uses. `tests/release_pin.rs` runs it as a
//! release build with overrides set, and expects the production hosts.

fn main() {
    let e = openagentd_cloud::endpoints::Endpoints::current();
    println!("{} {}", e.api, e.account);
}
