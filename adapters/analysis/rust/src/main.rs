//! Trusted sandbox helper. It never launches Cargo or a source-supplied command.
//!
//! The caller must enforce a read-only subject filesystem, no host/credential
//! mounts, no network, process/memory/output/time budgets, and a trusted rustc
//! path. `env_clear` prevents inherited credentials and compiler environment
//! macros from receiving the executor environment; it is not a filesystem
//! sandbox. Built-in include macros require the caller's filesystem isolation.

use klocgit_rust_mir::{json_string, parse_functions, COMPILER_IDENTITY, TOOLCHAIN_VERSION};
use std::env;
use std::fs;
use std::path::{Component, Path};
use std::process::Command;

fn run() -> Result<String, &'static str> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 5 {
        return Err("FAILED");
    }
    let (compiler, project, entry, edition, output) =
        (&args[0], &args[1], &args[2], &args[3], &args[4]);
    if !matches!(edition.as_str(), "2021" | "2024") {
        return Err("UNSUPPORTED");
    }
    if entry.is_empty()
        || entry.starts_with('-')
        || Path::new(entry).is_absolute()
        || Path::new(entry)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("FAILED");
    }
    let version = Command::new(compiler)
        .arg("--version")
        .env_clear()
        .output()
        .map_err(|_| "FAILED")?;
    if !version.status.success()
        || String::from_utf8_lossy(&version.stdout).trim() != COMPILER_IDENTITY
    {
        return Err("UNSUPPORTED");
    }
    let result = Command::new(compiler)
        .current_dir(project)
        .args([
            entry,
            "--crate-name",
            "klocgit_subject",
            "--crate-type",
            "lib",
            "--edition",
            edition,
            "--emit=mir",
            "--error-format=json",
            "--remap-path-prefix",
            &format!("{project}=/subject"),
            "-o",
            output,
        ])
        .env_clear()
        .output()
        .map_err(|_| "FAILED")?;
    if !result.status.success() {
        // Compiler diagnostics can contain source and sensitive include values.
        // The enclosing trusted runner retains separately budgeted diagnostics.
        return Err("FAILED");
    }
    let mir = fs::read_to_string(output).map_err(|_| "FAILED")?;
    let functions = parse_functions(&mir).map_err(|_| "FAILED")?;
    let functions = functions
        .into_iter()
        .map(|function| {
            let references = function
                .references
                .iter()
                .map(|value| json_string(value))
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{{\"name\":{},\"signature\":{},\"body\":{},\"references\":[{}]}}",
                json_string(&function.name),
                json_string(&function.signature),
                json_string(&function.body),
                references
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!("{{\"schema_version\":1,\"toolchain_version\":\"{TOOLCHAIN_VERSION}\",\"status\":\"COMPILED\",\"functions\":[{functions}]}}"))
}

fn main() {
    match run() {
        Ok(result) => println!("{result}"),
        Err(status) => println!("{{\"schema_version\":1,\"toolchain_version\":\"{TOOLCHAIN_VERSION}\",\"status\":\"{status}\",\"functions\":[]}}"),
    }
}
