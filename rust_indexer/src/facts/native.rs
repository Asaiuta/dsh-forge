//! Port of src/native-syntax.ts, src/cpp-modules.ts and src/cgo-facts.ts:
//! a small C/C++ lexical scanner that never expands macros. Offsets are char
//! indices into the text being scanned.

use super::{children, field, slice_utf16, static_string, text};
use serde_json::{json, Value};
use std::collections::HashSet;
use tree_sitter::Node;

#[derive(Clone, Copy, PartialEq)]
enum Kind { Word, Str, Punct, Directive }

#[derive(Clone)]
struct Token { text: String, start: usize, end: usize, line: u64, leading: bool, kind: Kind }

fn is_space(c: char) -> bool { super::is_js_space(c) }
fn is_word_start(c: char) -> bool { c.is_ascii_alphabetic() || c == '_' }
fn is_word_char(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' }

fn starts_with(s: &[char], at: usize, pat: &str) -> bool {
    let mut i = at;
    for p in pat.chars() {
        if s.get(i) != Some(&p) { return false; }
        i += 1;
    }
    true
}

fn index_of(s: &[char], pat: &str, from: usize) -> Option<usize> {
    let p: Vec<char> = pat.chars().collect();
    if p.is_empty() { return Some(from.min(s.len())); }
    (from..s.len().saturating_sub(p.len() - 1)).find(|&i| s[i..i + p.len()] == p[..])
}

fn lower_bound(values: &[usize], value: usize) -> usize {
    values.partition_point(|v| *v < value)
}

/// `(?:u8|u|U|L)?` prefix length at `i`, if followed by `next`.
fn encoding_prefix(s: &[char], i: usize) -> usize {
    if starts_with(s, i, "u8") { 2 } else if matches!(s.get(i), Some('u' | 'U' | 'L')) { 1 } else { 0 }
}

/// `^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(` on the next 24 chars: (match length, delimiter).
fn raw_open(s: &[char], i: usize) -> Option<(usize, String)> {
    let limit = (i + 24).min(s.len());
    let window = &s[i..limit];
    for prefix in [encoding_prefix(window, 0), 0] {
        if !starts_with(window, prefix, "R") { continue; }
        if let Some((length, delimiter)) = raw_delimiter_at_quote(window, prefix + 1) { return Some((prefix + 1 + length, delimiter)); }
    }
    None
}

/// `^"([^\s()\\]{0,16})\(` at `q`: (match length, delimiter).
fn raw_delimiter_at_quote(s: &[char], q: usize) -> Option<(usize, String)> {
    if s.get(q) != Some(&'"') { return None; }
    let mut j = q + 1;
    let mut delimiter = String::new();
    while j < s.len() && j - q - 1 < 16 && !(is_space(s[j]) || matches!(s[j], '(' | ')' | '\\')) {
        delimiter.push(s[j]);
        j += 1;
    }
    (s.get(j) == Some(&'(')).then(|| (j + 1 - q, delimiter))
}

fn tokens(original: &[char]) -> Vec<Token> {
    // Translation phase 2: splice backslash-newline, keeping a coordinate map.
    let mut coordinates: Option<Vec<usize>> = None;
    let mut line_starts = vec![0usize];
    let mut source: Vec<char> = original.to_vec();
    let has_splice = original.windows(2).any(|w| w == ['\\', '\n']) || original.windows(3).any(|w| w == ['\\', '\r', '\n']);
    if has_splice {
        let mut coords = Vec::with_capacity(original.len());
        let mut spliced = Vec::with_capacity(original.len());
        let mut at = 0;
        while at < original.len() {
            if original[at] == '\\' && original.get(at + 1) == Some(&'\n') { at += 2; continue; }
            if original[at] == '\\' && original.get(at + 1) == Some(&'\r') && original.get(at + 2) == Some(&'\n') { at += 3; continue; }
            coords.push(at);
            spliced.push(original[at]);
            at += 1;
        }
        for (at, c) in original.iter().enumerate() { if *c == '\n' { line_starts.push(at + 1); } }
        coordinates = Some(coords);
        source = spliced;
    }
    let mut out = Vec::new();
    let (mut i, mut line, mut line_start) = (0usize, 1u64, true);
    let advance = |i: &mut usize, line: &mut u64, line_start: &mut bool, end: usize, source: &[char]| {
        while *i < end {
            if source[*i] == '\n' { *line += 1; *line_start = true; }
            else if !matches!(source[*i], '\t' | '\r' | ' ') { *line_start = false; }
            *i += 1;
        }
    };
    let emit = |start: usize, i: usize, row: u64, kind: Kind, leading: bool, source: &[char]| -> Token {
        let offset = coordinates.as_ref().and_then(|c| c.get(start).copied()).unwrap_or(start);
        let end = match &coordinates {
            Some(c) => i.checked_sub(1).and_then(|k| c.get(k).copied()).unwrap_or(original.len().wrapping_sub(1)).wrapping_add(1),
            None => i,
        };
        let line = if coordinates.is_some() { lower_bound(&line_starts, offset + 1) as u64 } else { row };
        Token { text: source[start..i].iter().collect(), start: offset, end, line, leading, kind }
    };
    while i < source.len() {
        let c = source[i];
        let (start, row) = (i, line);
        let leading = line_start;
        if is_space(c) { let end = i + 1; advance(&mut i, &mut line, &mut line_start, end, &source); continue; }
        if starts_with(&source, i, "//") {
            let mut end = i;
            loop {
                end = index_of(&source, "\n", end + 1).unwrap_or(source.len());
                if !(end < source.len() && source[end - 1] == '\\') { break; }
            }
            advance(&mut i, &mut line, &mut line_start, end, &source);
            continue;
        }
        if starts_with(&source, i, "/*") {
            let initial = line;
            let end = index_of(&source, "*/", i + 2).map_or(source.len(), |e| e + 2);
            advance(&mut i, &mut line, &mut line_start, end, &source);
            line_start = leading || line > initial;
            continue;
        }
        if (c == '#' || starts_with(&source, i, "%:")) && line_start {
            let mut end = i;
            loop {
                end = index_of(&source, "\n", end + 1).unwrap_or(source.len());
                if !(end < source.len() && source[end - 1] == '\\') { break; }
            }
            advance(&mut i, &mut line, &mut line_start, end, &source);
            out.push(emit(start, i, row, Kind::Directive, leading, &source));
            continue;
        }
        if let Some((length, delimiter)) = raw_open(&source, i) {
            // Raw contents undo phase-2 splicing: search physical characters.
            let quote = i + source[i..i + length].iter().position(|c| *c == '"').unwrap_or(0);
            let physical_quote = coordinates.as_ref().and_then(|c| c.get(quote).copied()).unwrap_or(quote);
            let physical_open = raw_delimiter_at_quote(original, physical_quote).filter(|(_, d)| *d == delimiter).map(|(len, _)| len);
            let closing = format!("){delimiter}\"");
            let end = physical_open.and_then(|len| index_of(original, &closing, physical_quote + len));
            let physical_end = end.map_or(original.len(), |e| e + closing.chars().count());
            let target = match &coordinates { Some(c) => lower_bound(c, physical_end), None => physical_end };
            advance(&mut i, &mut line, &mut line_start, target, &source);
            out.push(emit(start, i, row, Kind::Str, leading, &source));
            continue;
        }
        let prefix = encoding_prefix(&source, i);
        let quoted = [prefix, 0].into_iter().find(|p| matches!(source.get(i + p), Some('"' | '\'')));
        if let Some(p) = quoted {
            let q = source[i + p];
            let mut end = i + p + 1;
            while end < source.len() {
                if source[end] == '\\' { end += 2; continue; }
                end += 1;
                if source[end - 1] == q { break; }
            }
            advance(&mut i, &mut line, &mut line_start, end.min(source.len()), &source);
            out.push(emit(start, i, row, Kind::Str, leading, &source));
            continue;
        }
        if c.is_ascii_digit() {
            let mut end = i + 1;
            while end < source.len() && (is_word_char(source[end]) || source[end] == '.'
                || source[end] == '\'' && source.get(end + 1).is_some_and(|n| is_word_char(*n))) { end += 1; }
            advance(&mut i, &mut line, &mut line_start, end, &source);
            out.push(emit(start, i, row, Kind::Word, leading, &source));
        } else if is_word_start(c) {
            let mut end = i + 1;
            while end < source.len() && is_word_char(source[end]) { end += 1; }
            advance(&mut i, &mut line, &mut line_start, end, &source);
            out.push(emit(start, i, row, Kind::Word, leading, &source));
        } else {
            let pair: String = source[i..(i + 2).min(source.len())].iter().collect();
            let digraph = match pair.as_str() { "<%" => Some("{"), "%>" => Some("}"), "<:" => Some("["), ":>" => Some("]"), _ => None };
            // <:: is the standard exception to the <: maximal-munch rule.
            let mapped = if pair == "<:" && source.get(i + 2) == Some(&':') && !matches!(source.get(i + 3), Some(':' | '>')) { None } else { digraph };
            let end = i + if mapped.is_some() { 2 } else { 1 };
            advance(&mut i, &mut line, &mut line_start, end, &source);
            let mut token = emit(start, i, row, Kind::Punct, leading, &source);
            if let Some(m) = mapped { token.text = m.to_string(); }
            out.push(token);
        }
    }
    out
}

fn chars_slice(s: &[char], start: usize, end: usize) -> String {
    if start >= end || start >= s.len() { return String::new(); }
    s[start..end.min(s.len())].iter().collect()
}

fn remove_splices(text: &str) -> String {
    text.replace("\\\r\n", "").replace("\\\n", "")
}

/// Literal include syntax only, after removing C comments and line splices.
fn native_include(token: &Token) -> Option<(String, &'static str)> {
    if token.kind != Kind::Directive { return None; }
    let source = remove_splices(&token.text);
    let rest = source.strip_prefix('#').or_else(|| source.strip_prefix("%:"))?;
    let rest = rest.trim_start_matches(is_space);
    let after = rest.strip_prefix("include")?;
    if after.chars().next().is_some_and(is_word_char) { return None; }
    let body: Vec<char> = after.chars().collect();
    let toks = tokens(&body);
    if toks.len() == 1 && toks[0].kind == Kind::Str {
        let t = &toks[0].text;
        if t.len() >= 3 && t.starts_with('"') && t.ends_with('"') && !t[1..t.len() - 1].contains(['"', '\\', '\r', '\n']) {
            return Some((t[1..t.len() - 1].to_string(), "quote"));
        }
    }
    if toks.first().is_some_and(|t| t.text == "<") && toks.last().is_some_and(|t| t.text == ">") {
        let spec = chars_slice(&body, toks[0].end, toks[toks.len() - 1].start);
        if !spec.is_empty() && !spec.contains(['<', '>', '\r', '\n']) { return Some((spec, "system")); }
    }
    let trimmed = slice_utf16(after.trim_matches(is_space), 80);
    Some((if trimmed.is_empty() { "…".into() } else { trimmed }, "dynamic"))
}

fn is_component(s: &str) -> bool {
    !s.is_empty() && s.split('.').all(|part| {
        let mut chars = part.chars();
        chars.next().is_some_and(is_word_start) && chars.all(is_word_char)
    })
}

fn named_module(s: &str) -> bool {
    match s.split_once(':') {
        Some((a, b)) => is_component(a) && is_component(b),
        None => is_component(s),
    }
}

fn partition(s: &str) -> bool {
    s.strip_prefix(':').is_some_and(is_component)
}

/// `name.replace(/\s*([.:])\s*/g, '$1')` on space-joined token texts.
fn join_module_name(values: &[Token]) -> String {
    let joined = values.iter().map(|t| t.text.as_str()).collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = joined.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if is_space(chars[i]) {
            let mut j = i;
            while j < chars.len() && is_space(chars[j]) { j += 1; }
            if j < chars.len() && matches!(chars[j], '.' | ':') { i = j; continue; }
            out.extend(&chars[i..j]);
            i = j;
            continue;
        }
        out.push(chars[i]);
        if matches!(chars[i], '.' | ':') {
            i += 1;
            while i < chars.len() && is_space(chars[i]) { i += 1; }
            continue;
        }
        i += 1;
    }
    out
}

fn has_module_keyword(source: &str) -> bool {
    let bytes = source.as_bytes();
    for keyword in ["module", "import"] {
        let mut from = 0;
        while let Some(at) = source[from..].find(keyword) {
            let start = from + at;
            let end = start + keyword.len();
            let before = start.checked_sub(1).map(|i| bytes[i]);
            let after = bytes.get(end).copied();
            let word = |b: Option<u8>| b.is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_');
            if !word(before) && !word(after) { return true; }
            from = start + 1;
        }
    }
    false
}

/// Lexical C++20 module facts: (modules, moduleInfo).
pub fn cpp_modules(source: &str) -> (Vec<Value>, Option<Value>) {
    if !has_module_keyword(source) && !source.contains("\\\n") && !source.contains("\\\r\n") { return (Vec::new(), None); }
    let original: Vec<char> = source.chars().collect();
    let all = tokens(&original);
    let mut macros = HashSet::new();
    for token in all.iter().filter(|t| t.kind == Kind::Directive) {
        let stripped = token.text.strip_prefix('#').or_else(|| token.text.strip_prefix("%:")).unwrap_or(&token.text);
        let parts = tokens(&stripped.chars().collect::<Vec<_>>());
        if parts.first().is_some_and(|p| p.text == "define" || p.text == "undef") && parts.get(1).is_some_and(|p| p.kind == Kind::Word) {
            macros.insert(parts[1].text.clone());
        }
    }
    let mut modules: Vec<Value> = Vec::new();
    let mut declarations: Vec<(String, bool, u64)> = Vec::new();
    let mut parse = |statement: &[Token]| {
        let Some(first) = statement.first() else { return };
        if !first.leading { return; }
        let exported = first.text == "export";
        let body = if exported { &statement[1..] } else { statement };
        let Some(keyword) = body.first().map(|t| t.text.as_str()) else { return };
        if keyword != "module" && keyword != "import" { return; }
        let values = &body[1..];
        let name = join_module_name(values);
        let line = first.line;
        let macro_used = statement.iter().any(|t| t.kind == Kind::Word && macros.contains(&t.text));
        let dynamic_spec = || { let s = slice_utf16(&name, 80); if s.is_empty() { "…".to_string() } else { s } };
        if keyword == "module" {
            if !macro_used && named_module(&name) { declarations.push((name.clone(), exported, line)); }
            return;
        }
        if macro_used {
            modules.push(json!({ "kind": "cpp_import", "spec": dynamic_spec(), "line": line, "dynamic": true }));
        } else if values.len() == 1 && values[0].kind == Kind::Str && {
            let t = &values[0].text;
            t.len() >= 3 && t.starts_with('"') && t.ends_with('"') && !t[1..t.len() - 1].contains(['"', '\\', '\r', '\n'])
        } {
            let t = &values[0].text;
            modules.push(json!({ "kind": "cpp_header", "spec": &t[1..t.len() - 1], "mode": "quote", "line": line }));
        } else if values.first().is_some_and(|t| t.text == "<") && values.last().is_some_and(|t| t.text == ">") {
            let spec = remove_splices(&chars_slice(&original, values[0].end, values[values.len() - 1].start));
            if !spec.is_empty() && !spec.contains(['<', '>', '\r', '\n']) {
                modules.push(json!({ "kind": "cpp_header", "spec": spec, "mode": "system", "line": line }));
            }
        } else if named_module(&name) || partition(&name) {
            modules.push(json!({ "kind": "cpp_import", "spec": name, "line": line }));
        } else {
            modules.push(json!({ "kind": "cpp_import", "spec": dynamic_spec(), "line": line, "dynamic": true }));
        }
    };
    let (mut statement, mut braces, mut parens, mut brackets): (Vec<Token>, usize, usize, usize) = (Vec::new(), 0, 0, 0);
    for token in all {
        if token.kind == Kind::Directive { continue; }
        if token.kind != Kind::Punct { if braces == 0 { statement.push(token); } continue; }
        match token.text.as_str() {
            "{" => { braces += 1; statement.clear(); continue; }
            "}" => { braces = braces.saturating_sub(1); statement.clear(); continue; }
            _ => {}
        }
        if braces > 0 { continue; }
        match token.text.as_str() {
            "(" => parens += 1,
            ")" => parens = parens.saturating_sub(1),
            "[" => brackets += 1,
            "]" => brackets = brackets.saturating_sub(1),
            _ => {}
        }
        if token.text == ";" && parens == 0 && brackets == 0 { parse(&statement); statement.clear(); }
        else { statement.push(token); }
    }
    // Multiple declarations cannot establish a module context for partitions.
    if declarations.len() == 1 && !declarations[0].1 && !declarations[0].0.contains(':') {
        let (name, _, line) = &declarations[0];
        modules.push(json!({ "kind": "cpp_implementation", "spec": name.split(':').next().unwrap_or(""), "line": line }));
    }
    modules.sort_by_key(super::line_of);
    let info = (!declarations.is_empty()).then(|| json!({ "cppModules": declarations.iter()
        .map(|(name, interface, line)| json!({ "name": name, "interface": interface, "line": line })).collect::<Vec<_>>() }));
    (modules, info)
}

/// Only the comment group immediately attached to a standalone `import "C"`.
pub fn cgo_includes(root: Node, src: &[u8], source: &str) -> Vec<Value> {
    let siblings = children(root);
    let mut modules = Vec::new();
    for (n, declaration) in siblings.iter().enumerate() {
        if declaration.kind() != "import_declaration" { continue; }
        let imports = children(*declaration);
        if imports.len() != 1 || imports[0].kind() != "import_spec" || field(imports[0], "name").is_some()
            || static_string(field(imports[0], "path"), src).as_deref() != Some("C") { continue; }
        let mut comments: Vec<Node> = Vec::new();
        let mut next = *declaration;
        for comment in siblings[..n].iter().rev() {
            if comment.kind() != "comment" || comment.end_position().row + 1 != next.start_position().row { break; }
            let start = comment.start_byte();
            let line_start = source[..start].rfind('\n').map_or(0, |at| at + 1);
            // Go attaches a trailing comment to the preceding code, not import.Doc.
            if !source[line_start..start].trim_matches(is_space).is_empty() { break; }
            comments.insert(0, *comment);
            next = *comment;
        }
        if comments.is_empty() { continue; }
        let preamble = comments.iter().map(|c| {
            let t = text(*c, src);
            if let Some(rest) = t.strip_prefix("//") { rest.to_string() }
            else { let inner: Vec<char> = t.chars().collect(); chars_slice(&inner, 2, inner.len().saturating_sub(2)) }
        }).collect::<Vec<_>>().join("\n");
        let base = comments[0].start_position().row as u64;
        for token in tokens(&preamble.chars().collect::<Vec<_>>()) {
            if let Some((spec, mode)) = native_include(&token) {
                modules.push(json!({ "kind": "cgo_include", "spec": spec, "mode": mode, "line": base + token.line }));
            }
        }
    }
    modules
}
