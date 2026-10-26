//! Trace link facts for the non-JavaScript module languages. A clean port of
//! src/module-facts.ts, language-facts.ts, java-facts.ts, ffi-facts.ts,
//! cpp-modules.ts and cgo-facts.ts: the JSON produced here must equal the
//! WASM path's `extractTraceFile` value field for field (rust_indexer/parity-facts.mjs).
//!
//! Line contract: 1-based rows on BOM-stripped, LF-normalized text. String
//! truncation counts UTF-16 code units, matching JavaScript `slice`.

mod ffi;
mod java;
mod js;
mod modules;
mod native;

use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use tree_sitter::{Language, Node};

/// Languages whose Trace facts this module produces.
pub fn supports_module_facts(lang: &str) -> bool {
    matches!(lang, "python" | "rust" | "c" | "cpp" | "go" | "java" | "lua")
}

pub fn supports_trace_facts(lang: &str) -> bool {
    supports_module_facts(lang) || is_js_family(lang)
}

fn is_js_family(lang: &str) -> bool {
    matches!(lang, "javascript" | "typescript" | "tsx")
}

/// The `value` of a TraceFileOutcome for a source file, plus the partial flag.
/// `None`: no grammar, no tree, or a tree too deep for the native walk.
pub fn trace_facts(text: &str, lang: &'static str) -> Option<(Value, bool)> {
    if !is_js_family(lang) { return source_facts(text, lang); }
    let (facts, partial) = text_facts(text, lang)?;
    let Value::Object(mut out) = serde_json::to_value(facts).ok()? else { return None };
    out.insert("kind".into(), json!("js"));
    out.insert("lang".into(), json!(lang));
    Some((Value::Object(out), partial))
}

/// `factsFromText`: script facts of a JS-family body (inline HTML/component scripts).
pub fn text_facts(text: &str, lang: &'static str) -> Option<(js::FileFacts, bool)> {
    let mut parser = crate::collect::parser_for(lang)?;
    let tree = parser.parse(text, None)?;
    let language = parser.language()?.to_owned();
    let root = tree.root_node();
    Some((with_language(language, || js::js_facts(root, text.as_bytes()))?, root.has_error()))
}

/// `{ kind: 'source', lang, modules, moduleInfo?, ffi? }` plus the partial flag.
pub fn source_facts(text: &str, lang: &'static str) -> Option<(Value, bool)> {
    let mut parser = crate::collect::parser_for(lang)?;
    let tree = parser.parse(text, None)?;
    let language = parser.language()?.to_owned();
    with_language(language, || source_value(tree.root_node(), text, lang))
}

fn source_value(root: Node, text: &str, lang: &'static str) -> Option<(Value, bool)> {
    let partial = root.has_error();
    let src = text.as_bytes();

    let cpp = if lang == "cpp" { Some(native::cpp_modules(text)) } else { None };
    let module_info = match &cpp {
        Some((_, Some(info))) => Some(info.clone()),
        _ => modules::module_info(root, src, lang),
    };
    let ffi = ffi::ffi_facts(root, src, lang);
    let mut all = modules::module_facts(root, src, lang);
    if let Some((cpp_modules, _)) = cpp { all.extend(cpp_modules); }
    if lang == "go" { all.extend(native::cgo_includes(root, src, text)); }
    // Stable sort by line, like Array.prototype.sort.
    all.sort_by_key(line_of);

    let mut out = Map::new();
    out.insert("kind".into(), json!("source"));
    out.insert("lang".into(), json!(lang));
    out.insert("modules".into(), Value::Array(all));
    if let Some(info) = module_info { out.insert("moduleInfo".into(), info); }
    if !ffi.is_empty() { out.insert("ffi".into(), Value::Array(ffi)); }
    Some((Value::Object(out), partial))
}

pub(crate) fn line_of(fact: &Value) -> u64 {
    fact.get("line").and_then(Value::as_u64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// web-tree-sitter equivalents
// ---------------------------------------------------------------------------

pub(crate) fn text<'a>(node: Node, src: &'a [u8]) -> &'a str {
    node.utf8_text(src).unwrap_or("")
}

pub(crate) fn line(node: Node) -> u64 {
    node.start_position().row as u64 + 1
}

/// `node.namedChildren`.
pub(crate) fn children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

/// `node.children` (named and anonymous).
pub(crate) fn all_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.children(&mut cursor).collect()
}

thread_local! {
    /// Field ids of the grammar extracted on this thread: name lookups scan the
    /// grammar's field table linearly, and the fact walks look fields up per node.
    static FIELDS: RefCell<Option<(Language, HashMap<&'static str, u16>)>> = const { RefCell::new(None) };
}

/// Run an extraction with `language`'s field ids cached for `field`.
pub(crate) fn with_language<R>(language: Language, run: impl FnOnce() -> R) -> R {
    let previous = FIELDS.with(|cell| cell.replace(Some((language, HashMap::new()))));
    let result = run();
    FIELDS.with(|cell| *cell.borrow_mut() = previous);
    result
}

pub(crate) fn field<'t>(node: Node<'t>, name: &'static str) -> Option<Node<'t>> {
    let id = FIELDS.with(|cell| {
        let mut cache = cell.borrow_mut();
        let (language, ids) = cache.as_mut()?;
        Some(*ids.entry(name).or_insert_with(|| language.field_id_for_name(name).map_or(0, |id| id.get())))
    });
    match id {
        Some(0) => None,
        Some(id) => node.child_by_field_id(id),
        None => node.child_by_field_name(name),
    }
}

/// `node.descendantsOfType(types)`: pre-order, the node itself included,
/// anonymous nodes included.
pub(crate) fn nodes<'t>(node: Node<'t>, types: &[&str]) -> Vec<Node<'t>> {
    // Every symbol carrying one of the names, named or anonymous (aliases
    // included), like web-tree-sitter's idsForType.
    let language = node.language();
    let wanted: Vec<bool> = (0..language.node_kind_count() as u16)
        .map(|id| language.node_kind_for_id(id).is_some_and(|kind| types.contains(&kind))).collect();
    let mut out = Vec::new();
    let mut cursor = node.walk();
    let mut depth = 0usize;
    loop {
        let current = cursor.node();
        if wanted.get(current.kind_id() as usize).copied().unwrap_or(false) { out.push(current); }
        if cursor.goto_first_child() { depth += 1; continue; }
        loop {
            if depth == 0 { return out; }
            if cursor.goto_next_sibling() { break; }
            cursor.goto_parent();
            depth -= 1;
        }
    }
}

/// JavaScript `text.slice(0, n)` — n UTF-16 code units, never splitting a
/// surrogate pair differently from JS (JS keeps the lone high surrogate; a
/// Rust String cannot, so the pair is dropped — the only representable choice).
pub(crate) fn slice_utf16(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if units + width > n { return text[..index].to_string(); }
        units += width;
        end = index + ch.len_utf8();
    }
    text[..end].to_string()
}

pub(crate) fn strip_r_hash(name: &str) -> String {
    name.strip_prefix("r#").unwrap_or(name).to_string()
}

pub(crate) fn remove_whitespace(text: &str) -> String {
    text.chars().filter(|c| !is_js_space(*c)).collect()
}

/// JavaScript regex `\s`.
pub(crate) fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `staticString` from language-facts.ts: reject interpolation and escapes.
pub(crate) fn static_string(node: Option<Node>, src: &[u8]) -> Option<String> {
    let node = node?;
    let t = text(node, src);
    // Long bracket: [==[ ... ]==]
    if let Some(rest) = t.strip_prefix('[') {
        let eq = rest.chars().take_while(|c| *c == '=').count();
        let open = format!("[{}[", "=".repeat(eq));
        let close = format!("]{}]", "=".repeat(eq));
        if t.starts_with(&open) && t.len() >= open.len() + close.len() && t.ends_with(&close) {
            let body = &t[open.len()..t.len() - close.len()];
            let body = body.strip_prefix("\r\n").or_else(|| body.strip_prefix('\n')).unwrap_or(body);
            return Some(body.to_string());
        }
    }
    if t.len() >= 2 && t.starts_with('`') && t.ends_with('`') && !t[1..t.len() - 1].contains('`') {
        return Some(t[1..t.len() - 1].to_string());
    }
    let body = t.strip_prefix(['r', 'R', 'u', 'U']).filter(|b| b.starts_with(['"', '\''])).unwrap_or(t);
    let quote = body.chars().next()?;
    if !(quote == '"' || quote == '\'') || body.len() < 2 || !body.ends_with(quote) { return None; }
    let inner = &body[1..body.len() - 1];
    if inner.contains(['\\', '\r', '\n']) || !nodes(node, &["interpolation"]).is_empty() { return None; }
    Some(inner.to_string())
}

#[cfg(test)]
mod bench {
    /// `DSH_FACTS_BENCH=<file> cargo test --release bench_one -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_one() {
        let path = std::env::var("DSH_FACTS_BENCH").expect("DSH_FACTS_BENCH");
        let text = std::fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
        let lang = crate::lang::detect_lang(&path).unwrap();
        for _ in 0..3 {
            let t = std::time::Instant::now();
            let mut parser = crate::collect::parser_for(lang).unwrap();
            let tree = parser.parse(&text, None).unwrap();
            let parsed = t.elapsed();
            let t = std::time::Instant::now();
            let language = parser.language().unwrap().to_owned();
            let facts = super::with_language(language, || super::js::js_facts(tree.root_node(), text.as_bytes()));
            let extracted = t.elapsed();
            let t = std::time::Instant::now();
            let json = serde_json::to_string(&facts).unwrap();
            println!("parse {parsed:?} extract {extracted:?} serialize {:?} ({} KB)", t.elapsed(), json.len() / 1024);
        }
    }
}
