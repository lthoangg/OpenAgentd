use super::*;

fn events(chunks: &[&[u8]]) -> Vec<(String, String)> {
    let mut p = SseParser::default();
    chunks.iter().flat_map(|c| p.feed(c)).map(|e| (e.event, e.data)).collect()
}

#[test]
fn sse_keeps_a_multibyte_char_split_across_chunks() {
    assert_eq!(events(&[b"data: {\"t\":\"\xC3", b"\xA9\"}\n\n"]), vec![("message".to_string(), "{\"t\":\"é\"}".to_string())]);
}

#[test]
fn sse_joins_data_lines_and_names_events() {
    let got = events(&[b": ping\r\nevent: msg\r\nid: 7\r\ndata: a\r\nda", b"ta: b\r\n\r\n\ndata: c\n\n"]);
    assert_eq!(got, vec![("msg".to_string(), "a\nb".to_string()), ("message".to_string(), "c".to_string())]);
}

#[test]
fn the_child_starts_in_the_given_directory_and_keeps_ours_without_one() {
    let d = tempfile::tempdir().unwrap();
    let cmd = stdio_command("srv", &["--x".to_string()], &[("K".to_string(), "v".to_string())], Some(d.path()));
    let std_cmd = cmd.as_std();
    assert_eq!(std_cmd.get_current_dir(), Some(d.path()));
    assert_eq!(std_cmd.get_program(), "srv");
    assert_eq!(std_cmd.get_args().collect::<Vec<_>>(), ["--x"]);
    assert_eq!(std_cmd.get_envs().find(|(k, _)| *k == "K").and_then(|(_, v)| v), Some(std::ffi::OsStr::new("v")));
    assert_eq!(stdio_command("srv", &[], &[], None).as_std().get_current_dir(), None);
}

#[test]
fn a_bad_working_directory_is_named_in_the_error() {
    let d = tempfile::tempdir().unwrap();
    let gone = d.path().join("gone");
    let e = McpClient::stdio_in("srv", &[], &[], Some(&gone)).err().expect("the spawn is refused");
    assert_eq!(e.type_name(), "FileNotFoundError");
    assert!(e.to_string().starts_with("[Errno 2] No such file or directory: '") && e.to_string().contains("gone"), "{e}");
    let file = d.path().join("file");
    std::fs::write(&file, "").unwrap();
    let e = McpClient::stdio_in("srv", &[], &[], Some(&file)).err().expect("a file is not a directory");
    assert_eq!(e.type_name(), "NotADirectoryError");
    assert!(e.to_string().starts_with("[Errno 20] Not a directory: '") && e.to_string().contains("file"), "{e}");
}
