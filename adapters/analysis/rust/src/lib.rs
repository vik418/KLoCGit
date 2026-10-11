//! Bounded facts from the stable `--emit=mir` option on one pinned compiler.
//!
//! MIR's human-readable format is not a stable interchange format. This parser
//! has deliberately narrow compatibility with rustc 1.90.0 and does not provide
//! an exhaustive symbol/type index, public API model, or sound call graph.

pub const TOOLCHAIN_VERSION: &str = "1.90.0";
pub const COMPILER_IDENTITY: &str = "rustc 1.90.0 (1159e78c4 2025-09-14)";

#[derive(Debug, PartialEq, Eq)]
pub struct Function {
    pub name: String,
    pub signature: String,
    pub body: String,
    pub references: Vec<String>,
}

/// Preserve MIR operation ordering; discard only whitespace and debug labels.
/// Direct literal callees are observations, not exhaustive dependency edges.
pub fn parse_functions(mir: &str) -> Result<Vec<Function>, &'static str> {
    if !mir.starts_with("// WARNING: This output format is intended for human consumers only") {
        return Err("unsupported_mir_format");
    }
    let mut functions = Vec::new();
    let mut current: Option<Function> = None;
    for line in mir.lines() {
        if line.starts_with("fn ") {
            if current.is_some() || !line.ends_with(" {") {
                return Err("unsupported_mir_function");
            }
            let signature = line.strip_suffix(" {").unwrap().to_owned();
            let name = signature
                .strip_prefix("fn ")
                .and_then(|value| value.split_once('('))
                .map(|(name, _)| name)
                .filter(|name| !name.is_empty())
                .ok_or("unsupported_mir_function")?;
            current = Some(Function {
                name: name.to_owned(),
                signature,
                body: String::new(),
                references: Vec::new(),
            });
        } else if line == "}" {
            if let Some(mut function) = current.take() {
                function.references.sort();
                function.references.dedup();
                functions.push(function);
            }
        } else if let Some(function) = current.as_mut() {
            let content = line.trim();
            if content.is_empty() || content.starts_with("//") || content.starts_with("debug ") {
                continue;
            }
            function.body.push_str(content);
            function.body.push('\n');
            if content.contains(" -> [") {
                if let Some((_, value)) = content.split_once(" = ") {
                    if let Some((callee, _)) = value.split_once('(') {
                        // Function pointers (`move _N`) and control operations
                        // have no literal resolved target in this representation.
                        if !callee.starts_with("move ")
                            && !callee.starts_with("copy ")
                            && !callee.contains('"')
                            && (callee.contains("::")
                                || callee.chars().all(|c| c.is_alphanumeric() || c == '_'))
                        {
                            function.references.push(callee.to_owned());
                        }
                    }
                }
            }
        }
    }
    if current.is_some() {
        return Err("truncated_mir_function");
    }
    functions.sort_by(|left, right| left.name.cmp(&right.name));
    if functions
        .windows(2)
        .any(|pair| pair[0].name == pair[1].name)
    {
        return Err("ambiguous_mir_function_identity");
    }
    Ok(functions)
}

/// JSON encoding without third-party dependencies in the trusted helper.
pub fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            character if character < ' ' => {
                out.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => out.push(character),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "// WARNING: This output format is intended for human consumers only\n";

    #[test]
    fn preserves_typed_body_order_and_literal_calls() {
        let mir = format!("{HEADER}fn call(_1: &str) -> usize {{\n    debug input => _1;\n    let mut _0: usize;\n    bb0: {{\n        _0 = core::str::<impl str>::len(copy _1) -> [return: bb1, unwind continue];\n    }}\n    bb1: {{\n        return;\n    }}\n}}\n");
        let facts = parse_functions(&mir).unwrap();
        assert_eq!(facts[0].signature, "fn call(_1: &str) -> usize");
        assert_eq!(facts[0].references, ["core::str::<impl str>::len"]);
        assert!(!facts[0].body.contains("debug input"));
        assert!(facts[0].body.find("bb0").unwrap() < facts[0].body.find("bb1:").unwrap());
    }

    #[test]
    fn rejects_unknown_truncated_or_ambiguous_representation() {
        assert!(parse_functions("fn absent() {}\n").is_err());
        assert!(parse_functions(&format!("{HEADER}fn truncated() -> () {{\n")).is_err());
        assert!(parse_functions(&format!(
            "{HEADER}fn a() -> () {{\n}}\nfn a() -> () {{\n}}\n"
        ))
        .is_err());
    }

    #[test]
    fn json_escapes_controls_and_quotes() {
        assert_eq!(json_string("a\n\"\\\u{0001}"), "\"a\\n\\\"\\\\\\u0001\"");
    }
}
