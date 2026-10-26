//! Language detection from a file extension. Mirrors `EXT_LANG` in src/ast.ts.
//! All eleven dsh-forge languages are parsed natively; their family tables and
//! language-specific collector branches live in collect.rs.

/// Extension -> language id, matching dsh-forge `detectLanguage`.
pub fn detect_lang(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    let lang = match ext.as_str() {
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "py" | "pyi" => "python",
        "rs" => "rust",
        "go" => "go",
        "c" => "c",
        "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" | "cppm" | "ixx" => "cpp",
        "java" => "java",
        "cs" => "c_sharp",
        "lua" => "lua",
        _ => return None,
    };
    Some(lang)
}

/// Whether the sidecar ships a native grammar for this language.
pub fn supported(lang: &str) -> bool {
    matches!(
        lang,
        "javascript" | "typescript" | "tsx"
            | "python" | "rust" | "go" | "c" | "cpp" | "java" | "c_sharp" | "lua"
    )
}