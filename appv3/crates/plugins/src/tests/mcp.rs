//! `mcp.json` of an Agent Plugins bundle: stdio servers, streamable HTTP
//! servers, and what is skipped.

use serde_json::{json, Value};

use super::{http, server_names, skill_names, stdio, transport, warned, Fixture};
use crate::{mcp, Bundle, Transport, MCP_SCHEMA};

/// A bundle with a `tool` script and the given `mcpServers`.
fn load_servers(servers: Value) -> (Fixture, Bundle) {
    let fixture = Fixture::agent_plugins("demo");
    fixture.script("bin/tool").mcp(servers);
    let bundle = fixture.bundle();
    (fixture, bundle)
}

/// A stdio entry with the given extra fields.
fn stdio_entry(extra: Value) -> Value {
    let mut entry = json!({ "type": "stdio", "command": "./bin/tool" });
    entry.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    entry
}

/// A bundle with one server `s` built from `entry`.
fn load_one(entry: Value) -> (Fixture, Bundle) {
    load_servers(json!({ "s": entry }))
}

/// The one warning of a bundle that skipped its only server.
fn only_warning(bundle: &Bundle) -> &str {
    assert_eq!(bundle.warnings.len(), 1, "{:?}", bundle.warnings);
    &bundle.warnings[0]
}

#[test]
fn stdio_server_with_a_dot_slash_command_gets_its_absolute_path() {
    let (fixture, bundle) = load_servers(json!({ "tool": { "type": "stdio", "command": "./bin/tool" } }));

    assert_eq!(stdio(&bundle, "tool").command, fixture.real_root().join("bin").join("tool").to_str().unwrap());
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn the_example_mcp_json_of_the_spec_loads_two_servers_and_skips_the_sse_one() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.script("bin/validator");
    fixture.mcp(json!({
        "local-validator": {
            "type": "stdio",
            "command": "./bin/validator",
            "args": ["--data", "${PLUGIN_DATA}/validator"],
            "env": { "CONFIG": "${PLUGIN_ROOT}/config.json" },
            "cwd": "${PLUGIN_ROOT}"
        },
        "deployment-api": { "type": "streamable-http", "url": "https://deploy.example.com/mcp", "headers": { "X-Tenant": "public-tenant" } },
        "legacy-events": { "type": "sse", "url": "https://legacy.example.com/sse" }
    }));
    let bundle = fixture.bundle();

    assert_eq!(server_names(&bundle), ["local-validator", "deployment-api"]);
    assert_eq!(bundle.warnings, ["mcp.json: server 'legacy-events' uses the sse transport, which is not supported; skipped"]);
}

#[test]
fn stdio_server_without_cwd_runs_in_the_plugin_root() {
    let (fixture, bundle) = load_one(stdio_entry(json!({})));
    assert_eq!(stdio(&bundle, "s").cwd, fixture.real_root());
}

#[test]
fn stdio_server_without_args_has_none() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({})));
    assert!(stdio(&bundle, "s").args.is_empty());
}

#[test]
fn stdio_env_always_has_plugin_root_and_plugin_data() {
    let (fixture, bundle) = load_one(stdio_entry(json!({})));
    let server = stdio(&bundle, "s");

    assert_eq!(server.env["PLUGIN_ROOT"], fixture.real_root().to_str().unwrap());
    assert_eq!(server.env["PLUGIN_DATA"], bundle.data_dir.to_str().unwrap());
    assert_eq!(server.env.len(), 2);
}

#[test]
fn placeholders_are_expanded_in_args_env_values_and_cwd() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.script("bin/tool");
    std::fs::create_dir(fixture.path("work")).unwrap();
    fixture.mcp(json!({
        "local-validator": {
            "type": "stdio",
            "command": "./bin/tool",
            "args": ["--data", "${PLUGIN_DATA}/validator", "--root=${PLUGIN_ROOT}"],
            "env": { "CONFIG": "${PLUGIN_ROOT}/config.json", "DATA_DIR": "${PLUGIN_DATA}/database", "PLAIN": "x" },
            "cwd": "${PLUGIN_ROOT}/work"
        }
    }));
    let bundle = fixture.bundle();
    let server = stdio(&bundle, "local-validator");
    let root = fixture.real_root();
    let root = root.to_str().unwrap();
    let data = bundle.data_dir.to_str().unwrap();

    assert_eq!(server.args, ["--data".to_string(), format!("{data}/validator"), format!("--root={root}")]);
    assert_eq!(server.env["CONFIG"], format!("{root}/config.json"));
    assert_eq!(server.env["DATA_DIR"], format!("{data}/database"));
    assert_eq!(server.env["PLAIN"], "x");
    assert_eq!(server.env["PLUGIN_ROOT"], root);
    assert_eq!(server.env["PLUGIN_DATA"], data);
    assert_eq!(server.cwd, fixture.real_root().join("work"));
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn every_occurrence_of_a_placeholder_is_replaced() {
    let (fixture, bundle) = load_one(stdio_entry(json!({ "args": ["${PLUGIN_ROOT}:${PLUGIN_ROOT}"] })));
    let root = fixture.real_root();
    let root = root.to_str().unwrap();

    assert_eq!(stdio(&bundle, "s").args, [format!("{root}:{root}")]);
}

#[test]
fn other_dollar_brace_text_stays_literal() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "args": ["${HOME}", "${PLUGIN_ROOT_X}", "$PLUGIN_ROOT", "${PLUGIN_ROOT", "${}"] })));

    assert_eq!(stdio(&bundle, "s").args, ["${HOME}", "${PLUGIN_ROOT_X}", "$PLUGIN_ROOT", "${PLUGIN_ROOT", "${}"]);
}

#[test]
fn expansion_does_not_rescan_replaced_text() {
    let substitutions = [("${PLUGIN_ROOT}", "${PLUGIN_DATA}"), ("${PLUGIN_DATA}", "data")];
    assert_eq!(mcp::expand("${PLUGIN_ROOT}/${PLUGIN_DATA}", &substitutions), "${PLUGIN_DATA}/data");
}

#[test]
fn expansion_leaves_text_without_placeholders_alone() {
    assert_eq!(mcp::expand("plain $ { } ${", &[("${A}", "x")]), "plain $ { } ${");
}

#[test]
fn expansion_is_safe_next_to_multi_byte_text() {
    let substitutions = [("${A}", "→")];
    assert_eq!(mcp::expand("é${A}é${", &substitutions), "é→é${");
    assert_eq!(mcp::expand("${é}${A}", &substitutions), "${é}→");
    assert_eq!(mcp::expand("日本${", &substitutions), "日本${");
}

#[test]
fn env_keys_are_not_expanded() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "env": { "${PLUGIN_ROOT}": "v" } })));
    assert_eq!(stdio(&bundle, "s").env["${PLUGIN_ROOT}"], "v");
}

#[test]
fn bare_command_is_kept_as_written() {
    let (_fixture, bundle) = load_one(json!({ "type": "stdio", "command": "npx", "args": ["-y", "some-server"] }));

    assert_eq!(stdio(&bundle, "s").command, "npx");
    assert_eq!(stdio(&bundle, "s").args, ["-y", "some-server"]);
}

#[test]
fn bare_command_does_not_need_to_exist() {
    let (_fixture, bundle) = load_one(json!({ "type": "stdio", "command": "definitely-not-installed" }));
    assert_eq!(server_names(&bundle), ["s"]);
}

#[test]
fn command_with_a_placeholder_is_not_expanded_and_is_rejected() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "command": "${PLUGIN_ROOT}/bin/tool" })));

    assert!(bundle.mcp_servers.is_empty());
    assert!(only_warning(&bundle).starts_with("mcp.json: server 's' has an invalid 'command'"), "{:?}", bundle.warnings);
}

#[test]
fn command_holding_a_whole_command_line_is_rejected() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "command": "npx -y some-server" })));

    assert!(bundle.mcp_servers.is_empty());
    assert!(only_warning(&bundle).contains("arguments go in 'args'"), "{:?}", bundle.warnings);
}

#[test]
fn command_path_that_is_not_dot_slash_is_rejected() {
    for command in ["bin/tool", "/usr/bin/env", "../tool", "bin\\tool"] {
        let (_fixture, bundle) = load_one(stdio_entry(json!({ "command": command })));
        assert!(bundle.mcp_servers.is_empty(), "{command}");
        assert!(warned(&bundle, "has an invalid 'command'"), "{command}: {:?}", bundle.warnings);
    }
}

#[test]
fn empty_command_is_rejected() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "command": "" })));
    assert!(bundle.mcp_servers.is_empty());
}

#[test]
fn dot_slash_command_that_does_not_exist_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "command": "./bin/missing" })));

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has an invalid 'command' ('./bin/missing' does not exist); skipped"]);
}

#[test]
fn dot_slash_command_that_is_a_folder_skips_the_entry() {
    let fixture = Fixture::agent_plugins("demo");
    std::fs::create_dir_all(fixture.path("bin/tool")).unwrap();
    fixture.mcp(json!({ "s": { "type": "stdio", "command": "./bin/tool" } }));
    let bundle = fixture.bundle();

    assert!(bundle.mcp_servers.is_empty());
    assert!(warned(&bundle, "'./bin/tool' is not a file"), "{:?}", bundle.warnings);
}

#[test]
fn dot_slash_command_that_climbs_out_of_the_root_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "command": "./.." })));

    assert!(bundle.mcp_servers.is_empty());
    assert!(warned(&bundle, "resolves outside the plugin folder"), "{:?}", bundle.warnings);
}

#[cfg(unix)]
#[test]
fn dot_slash_command_symlinked_outside_the_root_skips_the_entry() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("evil"), "#!/bin/sh\n").unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.symlink(&outside.path().join("evil"), "bin/tool");
    fixture.mcp(json!({ "s": { "type": "stdio", "command": "./bin/tool" } }));
    let bundle = fixture.bundle();

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has an invalid 'command' ('./bin/tool' resolves outside the plugin folder); skipped"]);
}

#[cfg(unix)]
#[test]
fn dot_slash_command_symlinked_inside_the_root_resolves_to_its_target() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.script("real/tool");
    fixture.symlink(&fixture.path("real/tool"), "bin/tool");
    fixture.mcp(json!({ "s": { "type": "stdio", "command": "./bin/tool" } }));
    let bundle = fixture.bundle();

    assert_eq!(stdio(&bundle, "s").command, fixture.real_root().join("real").join("tool").to_str().unwrap());
}

#[test]
fn reserved_env_plugin_root_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "env": { "PLUGIN_ROOT": "/elsewhere" } })));

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: server 's' sets 'PLUGIN_ROOT' in 'env', but the client provides it; skipped"]);
}

#[test]
fn reserved_env_plugin_data_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "env": { "OK": "1", "PLUGIN_DATA": "/elsewhere" } })));

    assert!(bundle.mcp_servers.is_empty());
    assert!(warned(&bundle, "'PLUGIN_DATA'"), "{:?}", bundle.warnings);
}

#[test]
fn env_that_is_not_an_object_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "env": ["A=B"] })));
    assert!(only_warning(&bundle).contains("has an 'env' that is not an object of strings"));
}

#[test]
fn env_value_that_is_not_a_string_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "env": { "PORT": 8080 } })));
    assert!(only_warning(&bundle).contains("has a value for env 'PORT' that is not a string"));
}

#[test]
fn env_name_with_an_equals_sign_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "env": { "A=B": "x" } })));
    assert!(only_warning(&bundle).contains("has an invalid env entry 'A=B'"));
}

#[test]
fn args_that_are_not_an_array_of_strings_skip_the_entry() {
    for args in [json!("--flag"), json!(["ok", 1])] {
        let (_fixture, bundle) = load_one(stdio_entry(json!({ "args": args })));
        assert!(bundle.mcp_servers.is_empty());
        assert!(only_warning(&bundle).contains("has an 'args' that is not an array of strings"));
    }
}

#[test]
fn cwd_dot_slash_folder_inside_the_root_is_accepted() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.script("bin/tool");
    std::fs::create_dir(fixture.path("work")).unwrap();
    fixture.mcp(json!({ "s": { "type": "stdio", "command": "./bin/tool", "cwd": "./work" } }));
    let bundle = fixture.bundle();

    assert_eq!(stdio(&bundle, "s").cwd, fixture.real_root().join("work"));
}

#[test]
fn cwd_dot_slash_alone_is_the_root() {
    let (fixture, bundle) = load_one(stdio_entry(json!({ "cwd": "./" })));
    assert_eq!(stdio(&bundle, "s").cwd, fixture.real_root());
}

#[test]
fn cwd_plugin_root_placeholder_alone_is_the_root() {
    let (fixture, bundle) = load_one(stdio_entry(json!({ "cwd": "${PLUGIN_ROOT}" })));
    assert_eq!(stdio(&bundle, "s").cwd, fixture.real_root());
}

#[test]
fn cwd_plugin_root_placeholder_with_a_subfolder_is_accepted() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.script("bin/tool");
    std::fs::create_dir_all(fixture.path("a/b")).unwrap();
    fixture.mcp(json!({ "s": { "type": "stdio", "command": "./bin/tool", "cwd": "${PLUGIN_ROOT}/a/b" } }));

    assert_eq!(stdio(&fixture.bundle(), "s").cwd, fixture.real_root().join("a").join("b"));
}

#[test]
fn cwd_in_a_folder_that_does_not_exist_yet_is_accepted() {
    let (fixture, bundle) = load_one(stdio_entry(json!({ "cwd": "./not-yet/here" })));

    assert_eq!(stdio(&bundle, "s").cwd, fixture.real_root().join("not-yet").join("here"));
}

#[test]
fn cwd_plugin_data_placeholder_alone_is_the_data_dir() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "cwd": "${PLUGIN_DATA}" })));
    assert_eq!(stdio(&bundle, "s").cwd, bundle.data_dir);
}

#[test]
fn cwd_plugin_data_subfolder_is_accepted_although_the_data_dir_does_not_exist() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "cwd": "${PLUGIN_DATA}/x" })));

    assert_eq!(stdio(&bundle, "s").cwd, bundle.data_dir.join("x"));
    assert!(!bundle.data_dir.exists());
}

#[test]
fn cwd_plugin_data_with_dot_dot_that_stays_inside_is_normalised() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "cwd": "${PLUGIN_DATA}/a/../b/./c" })));
    assert_eq!(stdio(&bundle, "s").cwd, bundle.data_dir.join("b").join("c"));
}

#[test]
fn cwd_plugin_data_that_climbs_out_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "cwd": "${PLUGIN_DATA}/../other" })));

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has an invalid 'cwd' (it resolves outside the plugin data folder); skipped"]);
}

#[test]
fn cwd_dot_slash_that_climbs_out_of_the_root_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "cwd": "./../" })));

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has an invalid 'cwd' (it resolves outside the plugin folder); skipped"]);
}

#[test]
fn cwd_plugin_root_that_climbs_out_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "cwd": "${PLUGIN_ROOT}/../x" })));

    assert!(bundle.mcp_servers.is_empty());
    assert!(warned(&bundle, "has an invalid 'cwd'"), "{:?}", bundle.warnings);
}

#[test]
fn cwd_that_is_neither_relative_with_dot_slash_nor_placeholder_rooted_skips_the_entry() {
    for cwd in ["work", ".", "/tmp", "../x", "~/x", "${PLUGIN_ROOT}work", "${PLUGIN_DATA}x", "${PLUGIN_ROOT_X}/a", "$PLUGIN_ROOT", "${HOME}/x"] {
        let (_fixture, bundle) = load_one(stdio_entry(json!({ "cwd": cwd })));
        assert!(bundle.mcp_servers.is_empty(), "{cwd}");
        assert!(warned(&bundle, "has an invalid 'cwd' (it must start with './', '${PLUGIN_ROOT}' or '${PLUGIN_DATA}')"), "{cwd}: {:?}", bundle.warnings);
    }
}

#[test]
fn cwd_that_is_not_a_string_skips_the_entry() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "cwd": 3 })));
    assert!(only_warning(&bundle).contains("has a 'cwd' that is not a string"));
}

#[cfg(unix)]
#[test]
fn cwd_symlinked_outside_the_root_skips_the_entry() {
    let outside = tempfile::tempdir().unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.script("bin/tool");
    fixture.symlink(outside.path(), "link");
    fixture.mcp(json!({ "s": { "type": "stdio", "command": "./bin/tool", "cwd": "./link/sub" } }));
    let bundle = fixture.bundle();

    assert!(bundle.mcp_servers.is_empty());
    assert!(warned(&bundle, "it resolves outside the plugin folder"), "{:?}", bundle.warnings);
}

#[test]
fn stdio_server_without_a_command_is_skipped() {
    let (_fixture, bundle) = load_one(json!({ "type": "stdio" }));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' is missing 'command'; skipped"]);
}

#[test]
fn command_that_is_not_a_string_is_skipped() {
    let (_fixture, bundle) = load_one(json!({ "type": "stdio", "command": ["a"] }));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has a 'command' that is not a string; skipped"]);
}

#[test]
fn server_without_a_type_is_skipped() {
    let (_fixture, bundle) = load_one(json!({ "command": "npx" }));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' is missing 'type'; skipped"]);
}

#[test]
fn type_that_is_not_a_string_is_skipped() {
    let (_fixture, bundle) = load_one(json!({ "type": 1, "command": "npx" }));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has a 'type' that is not a string; skipped"]);
}

#[test]
fn unknown_type_is_skipped() {
    let (_fixture, bundle) = load_one(json!({ "type": "grpc", "url": "https://example.com" }));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has unknown type 'grpc'; skipped"]);
}

#[test]
fn http_is_an_unknown_type_name() {
    let (_fixture, bundle) = load_one(json!({ "type": "http", "url": "https://example.com/mcp" }));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has unknown type 'http'; skipped"]);
}

#[test]
fn sse_server_is_skipped_with_a_warning() {
    let (_fixture, bundle) = load_servers(json!({ "legacy-events": { "type": "sse", "url": "https://legacy.example.com/sse" } }));

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: server 'legacy-events' uses the sse transport, which is not supported; skipped"]);
}

#[test]
fn entry_that_is_not_an_object_is_skipped() {
    let (_fixture, bundle) = load_one(json!("npx"));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' is not an object; skipped"]);
}

#[test]
fn unknown_field_skips_the_entry_and_names_it() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "timeout": 30 })));

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has unknown field 'timeout'; skipped"]);
}

#[test]
fn http_field_in_a_stdio_entry_skips_it_and_names_the_field() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({ "url": "https://example.com/mcp" })));

    assert_eq!(bundle.warnings, ["mcp.json: server 's' has field 'url', which does not belong to a stdio server; skipped"]);
}

#[test]
fn stdio_field_in_an_http_entry_skips_it_and_names_the_field() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://example.com/mcp", "command": "npx" }));

    assert_eq!(bundle.warnings, ["mcp.json: server 's' has field 'command', which does not belong to a streamable-http server; skipped"]);
}

#[test]
fn one_bad_entry_does_not_drop_the_others() {
    let (_fixture, bundle) = load_servers(json!({
        "first": { "type": "stdio", "command": "./bin/tool" },
        "broken": { "type": "stdio", "command": "./bin/missing" },
        "last": { "type": "streamable-http", "url": "https://example.com/mcp" }
    }));

    assert_eq!(server_names(&bundle), ["first", "last"]);
    assert_eq!(bundle.warnings.len(), 1);
    assert!(warned(&bundle, "server 'broken'"));
}

#[test]
fn servers_keep_the_order_of_the_file() {
    let (_fixture, bundle) = load_servers(json!({
        "zeta": { "type": "stdio", "command": "z" },
        "alpha": { "type": "stdio", "command": "a" },
        "mid": { "type": "stdio", "command": "m" }
    }));

    assert_eq!(server_names(&bundle), ["zeta", "alpha", "mid"]);
}

#[test]
fn server_with_an_empty_name_is_skipped() {
    let (_fixture, bundle) = load_servers(json!({ "": { "type": "stdio", "command": "x" }, "ok": { "type": "stdio", "command": "x" } }));

    assert_eq!(server_names(&bundle), ["ok"]);
    assert_eq!(bundle.warnings, ["mcp.json: a server has an invalid name; skipped"]);
}

#[test]
fn empty_mcp_servers_is_valid() {
    let (_fixture, bundle) = load_servers(json!({}));

    assert!(bundle.mcp_servers.is_empty());
    assert!(bundle.warnings.is_empty());
}

#[test]
fn missing_mcp_json_is_not_an_error() {
    let bundle = Fixture::agent_plugins("demo").bundle();

    assert!(bundle.mcp_servers.is_empty());
    assert!(bundle.warnings.is_empty());
}

#[test]
fn wrong_mcp_schema_drops_every_server_but_skills_still_load() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("keep", "Still here.");
    fixture.write_json("mcp.json", &json!({ "$schema": "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json", "mcpServers": { "a": { "type": "stdio", "command": "a" } } }));
    let bundle = fixture.bundle();

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(skill_names(&bundle), ["keep"]);
    assert_eq!(bundle.warnings, ["mcp.json: unsupported '$schema' https://agent-plugins.org/schemas/2.0.0/mcp.schema.json; MCP servers ignored"]);
}

#[test]
fn missing_mcp_schema_drops_every_server() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write_json("mcp.json", &json!({ "mcpServers": { "a": { "type": "stdio", "command": "a" } } }));
    let bundle = fixture.bundle();

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: missing '$schema'; MCP servers ignored"]);
}

#[test]
fn mcp_json_with_invalid_json_drops_every_server() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("mcp.json", "{ nope");
    let bundle = fixture.bundle();

    assert!(bundle.mcp_servers.is_empty());
    assert!(bundle.warnings[0].starts_with("mcp.json: is not valid JSON"), "{:?}", bundle.warnings);
}

#[test]
fn mcp_json_that_is_not_an_object_drops_every_server() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("mcp.json", "[]");
    assert_eq!(fixture.bundle().warnings, ["mcp.json: must be a JSON object; MCP servers ignored"]);
}

#[test]
fn mcp_json_without_mcp_servers_drops_every_server() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write_json("mcp.json", &json!({ "$schema": MCP_SCHEMA }));
    assert_eq!(fixture.bundle().warnings, ["mcp.json: missing 'mcpServers'; MCP servers ignored"]);
}

#[test]
fn mcp_servers_that_is_not_an_object_drops_every_server() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write_json("mcp.json", &json!({ "$schema": MCP_SCHEMA, "mcpServers": [] }));
    assert_eq!(fixture.bundle().warnings, ["mcp.json: 'mcpServers' must be an object; MCP servers ignored"]);
}

#[test]
fn extra_top_level_field_in_mcp_json_drops_every_server() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write_json("mcp.json", &json!({ "$schema": MCP_SCHEMA, "mcpServers": { "a": { "type": "stdio", "command": "a" } }, "version": 1 }));
    let bundle = fixture.bundle();

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: unknown top-level field 'version'; MCP servers ignored"]);
}

#[test]
fn mcp_json_that_is_a_folder_drops_every_server() {
    let fixture = Fixture::agent_plugins("demo");
    std::fs::create_dir(fixture.path("mcp.json")).unwrap();
    assert_eq!(fixture.bundle().warnings, ["mcp.json: not a regular file; MCP servers ignored"]);
}

#[cfg(unix)]
#[test]
fn mcp_json_symlinked_outside_the_root_drops_every_server() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("mcp.json"), format!("{{\"$schema\": \"{MCP_SCHEMA}\", \"mcpServers\": {{\"a\": {{\"type\": \"stdio\", \"command\": \"a\"}}}}}}")).unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.symlink(&outside.path().join("mcp.json"), "mcp.json");
    let bundle = fixture.bundle();

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: resolves outside the plugin folder; MCP servers ignored"]);
}

#[test]
fn streamable_http_server_keeps_its_url_and_headers() {
    let (_fixture, bundle) = load_servers(json!({
        "deployment-api": { "type": "streamable-http", "url": "https://deploy.example.com/mcp", "headers": { "X-Tenant": "public-tenant" } }
    }));
    let (url, headers) = http(&bundle, "deployment-api");

    assert_eq!(url, "https://deploy.example.com/mcp");
    assert_eq!(headers["X-Tenant"], "public-tenant");
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn http_server_without_headers_has_none() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://example.com/mcp" }));
    assert!(http(&bundle, "s").1.is_empty());
}

#[test]
fn http_url_to_localhost_is_allowed() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "http://localhost:8080/mcp" }));
    assert_eq!(http(&bundle, "s").0, "http://localhost:8080/mcp");
}

#[test]
fn http_url_to_a_loopback_ip_is_allowed() {
    for url in ["http://127.0.0.1/mcp", "http://127.8.9.10:3000/", "http://[::1]:3000/mcp"] {
        let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": url }));
        assert_eq!(http(&bundle, "s").0, url);
    }
}

#[test]
fn http_url_to_another_host_is_rejected() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "http://example.com/mcp" }));

    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has an invalid 'url' (plain http is only allowed for localhost and loopback addresses; use https); skipped"]);
}

#[test]
fn url_with_user_information_is_rejected() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://user:secret@example.com/mcp" }));

    assert!(bundle.mcp_servers.is_empty());
    assert!(only_warning(&bundle).contains("it contains user information"));
}

#[test]
fn url_with_a_fragment_is_rejected() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://example.com/mcp#section" }));

    assert!(bundle.mcp_servers.is_empty());
    assert!(only_warning(&bundle).contains("it contains a fragment"));
}

#[test]
fn url_that_is_not_absolute_http_is_rejected() {
    for url in ["/mcp", "example.com/mcp", "ftp://example.com/mcp", "file:///etc/passwd", ""] {
        let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": url }));
        assert!(bundle.mcp_servers.is_empty(), "{url}");
        assert!(warned(&bundle, "has an invalid 'url'"), "{url}: {:?}", bundle.warnings);
    }
}

#[test]
fn url_that_is_not_a_string_is_skipped() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": 5 }));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has a 'url' that is not a string; skipped"]);
}

#[test]
fn http_server_without_a_url_is_skipped() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http" }));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' is missing 'url'; skipped"]);
}

#[test]
fn headers_that_differ_only_in_case_are_rejected() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://example.com/mcp", "headers": { "X-Tenant": "a", "x-tenant": "b" } }));

    assert!(bundle.mcp_servers.is_empty());
    assert!(only_warning(&bundle).contains("has duplicate names in 'headers' ('x-tenant' repeats 'X-Tenant'"), "{:?}", bundle.warnings);
}

#[test]
fn header_name_that_is_not_a_token_is_rejected() {
    for name in ["Bad Name", "X:Y", "", "Ünï"] {
        let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://example.com/mcp", "headers": { name: "v" } }));
        assert!(bundle.mcp_servers.is_empty(), "{name:?}");
        assert!(warned(&bundle, "has an invalid name in 'headers'"), "{name:?}: {:?}", bundle.warnings);
    }
}

#[test]
fn header_value_with_a_line_break_is_rejected() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://example.com/mcp", "headers": { "X-A": "one\r\nX-B: two" } }));

    assert!(bundle.mcp_servers.is_empty());
    assert!(only_warning(&bundle).contains("has an invalid value in 'headers' for 'X-A'"));
}

#[test]
fn header_value_that_is_not_a_string_is_rejected() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://example.com/mcp", "headers": { "X-A": 1 } }));
    assert!(only_warning(&bundle).contains("has a value in 'headers' that is not a string ('X-A')"));
}

#[test]
fn headers_that_are_not_an_object_are_rejected() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://example.com/mcp", "headers": ["X-A: 1"] }));
    assert_eq!(bundle.warnings, ["mcp.json: server 's' has 'headers' that is not an object of strings; skipped"]);
}

#[test]
fn url_and_headers_are_never_expanded() {
    let (_fixture, bundle) = load_one(json!({
        "type": "streamable-http",
        "url": "https://example.com/${PLUGIN_ROOT}/mcp",
        "headers": { "X-Data": "${PLUGIN_DATA}" }
    }));
    let (url, headers) = http(&bundle, "s");

    assert_eq!(url, "https://example.com/${PLUGIN_ROOT}/mcp");
    assert_eq!(headers["X-Data"], "${PLUGIN_DATA}");
}

#[test]
fn header_names_keep_the_case_they_were_written_in() {
    let (_fixture, bundle) = load_one(json!({ "type": "streamable-http", "url": "https://example.com/mcp", "headers": { "x-Mixed-CASE": "v" } }));
    assert_eq!(http(&bundle, "s").1.keys().collect::<Vec<_>>(), ["x-Mixed-CASE"]);
}

#[test]
fn transport_of_a_stdio_server_is_the_stdio_variant() {
    let (_fixture, bundle) = load_one(stdio_entry(json!({})));
    assert!(matches!(transport(&bundle, "s"), Transport::Stdio { .. }));
}
