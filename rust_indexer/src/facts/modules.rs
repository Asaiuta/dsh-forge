//! Port of src/module-facts.ts and src/language-facts.ts (imports, includes,
//! `mod`/`use`, Lua `require`, Python dynamic imports, module info).

use super::{children, field, is_js_space, line, nodes, remove_whitespace, slice_utf16, static_string, strip_r_hash, text};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use tree_sitter::Node;

pub fn module_facts(root: Node, src: &[u8], lang: &str) -> Vec<Value> {
    match lang {
        "go" => go_facts(root, src),
        "java" => super::java::java_facts(root, src),
        "lua" => lua_facts(root, src),
        _ => tree_facts(root, src, lang),
    }
}

fn python_name(node: Node, src: &[u8]) -> String {
    remove_whitespace(&text(node, src).replace("\\\n", ""))
}

fn unalias(node: Node) -> Node {
    if node.kind() == "aliased_import" { field(node, "name").unwrap_or(node) } else { node }
}

fn tree_facts(root: Node, src: &[u8], lang: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut attributes = RustAttributes::default();
    let types: &[&str] = match lang {
        "python" => &["import_statement", "import_from_statement"],
        "rust" => &["mod_item", "macro_invocation", "use_declaration"],
        _ => &["preproc_include"],
    };
    for node in nodes(root, types) {
        let ln = line(node);
        if lang == "python" {
            if node.kind() == "import_statement" {
                for child in children(node) {
                    let name = unalias(child);
                    if name.kind() == "dotted_name" {
                        out.push(json!({ "kind": "python_import", "spec": python_name(name, src), "line": ln }));
                    }
                }
            } else {
                let Some(module) = field(node, "module_name") else { continue };
                let names: Vec<String> = children(node).into_iter().filter(|c| c.id() != module.id()).map(unalias)
                    .filter(|c| c.kind() == "dotted_name").map(|c| python_name(c, src)).collect();
                out.push(json!({ "kind": "python_from", "spec": python_name(module, src), "names": names, "line": ln }));
            }
        } else if lang == "rust" {
            match node.kind() {
                "use_declaration" => {
                    let scope = mod_scope(node.parent(), src);
                    if let Some(argument) = field(node, "argument") {
                        visit_use(argument, String::new(), src, ln, &scope, &mut out);
                    }
                }
                "mod_item" => {
                    if field(node, "body").is_some() { continue; } // inline modules have no file of their own
                    let Some(name) = field(node, "name") else { continue };
                    let mut scope = Vec::new();
                    let mut unsupported = false;
                    let mut parent = node.parent();
                    while let Some(p) = parent {
                        if p.kind() == "mod_item" {
                            if let Some(owner) = field(p, "name") { scope.insert(0, strip_r_hash(text(owner, src))); }
                            let attribute = rust_path(p, src, &mut attributes);
                            unsupported |= attribute.path.is_some() || attribute.dynamic;
                        }
                        parent = p.parent();
                    }
                    let attribute = rust_path(node, src, &mut attributes);
                    let mut fact = Map::new();
                    fact.insert("kind".into(), json!("rust_mod"));
                    fact.insert("spec".into(), json!(strip_r_hash(text(name, src))));
                    fact.insert("line".into(), json!(ln));
                    fact.insert("scope".into(), json!(scope));
                    if let Some(path) = attribute.path { fact.insert("path".into(), json!(path)); }
                    if attribute.dynamic || unsupported { fact.insert("dynamic".into(), json!(true)); }
                    out.push(Value::Object(fact));
                }
                _ => {
                    let kids = children(node);
                    if !is_include_macro(kids.first().map(|k| text(*k, src)).unwrap_or("")) { continue; }
                    let tokens = kids.iter().find(|c| c.kind() == "token_tree").copied();
                    let args = tokens.map(children).unwrap_or_default();
                    let spec = if args.len() == 1 { rust_string(Some(args[0]), src) } else { None };
                    let shown = spec.clone().unwrap_or_else(|| tokens.map(|t| slice_utf16(text(t, src), 80)).unwrap_or_else(|| "…".into()));
                    let mut fact = json!({ "kind": "rust_include", "spec": shown, "line": ln });
                    if spec.is_none() { fact["dynamic"] = json!(true); }
                    out.push(fact);
                }
            }
        } else {
            let Some(include) = field(node, "path") else { continue };
            let mode = match include.kind() { "string_literal" => "quote", "system_lib_string" => "system", _ => "dynamic" };
            let t = text(include, src);
            let spec = if mode == "dynamic" { slice_utf16(t, 80) } else { js_slice_inner(t) };
            out.push(json!({ "kind": "c_include", "spec": spec, "line": ln, "mode": mode }));
        }
    }
    if lang == "python" {
        out.extend(python_dynamic(root, src));
        out.sort_by_key(super::line_of);
    }
    out
}

/// JavaScript `text.slice(1, -1)`.
fn js_slice_inner(t: &str) -> String {
    let mut chars = t.chars();
    if chars.next().is_none() { return String::new(); }
    chars.next_back();
    chars.as_str().to_string()
}

fn mod_scope(mut parent: Option<Node>, src: &[u8]) -> Vec<String> {
    let mut scope = Vec::new();
    while let Some(p) = parent {
        if p.kind() == "mod_item" {
            if let Some(name) = field(p, "name") { scope.insert(0, strip_r_hash(text(name, src))); }
        }
        parent = p.parent();
    }
    scope
}

fn visit_use(part: Node, prefix: String, src: &[u8], ln: u64, scope: &[String], out: &mut Vec<Value>) {
    match part.kind() {
        "scoped_use_list" => {
            let next = match field(part, "path") {
                Some(owner) => format!("{prefix}{}::", remove_whitespace(text(owner, src))),
                None => prefix,
            };
            if let Some(list) = field(part, "list") {
                for child in children(list) { visit_use(child, next.clone(), src, ln, scope, out); }
            }
        }
        "use_list" => for child in children(part) { visit_use(child, prefix.clone(), src, ln, scope, out) },
        "use_as_clause" => if let Some(target) = field(part, "path") { visit_use(target, prefix, src, ln, scope, out) },
        _ => {
            let mut spec = remove_whitespace(&format!("{prefix}{}", text(part, src)));
            if spec.ends_with("::") { spec.truncate(spec.len() - 2); }
            out.push(json!({ "kind": "rust_use", "spec": spec, "line": ln, "scope": scope }));
        }
    }
}

/// `^(?:(?:::)?(?:std|core)::)?(?:include|include_str|include_bytes)$`
fn is_include_macro(name: &str) -> bool {
    let rest = name.strip_prefix("::").filter(|r| r.starts_with("std::") || r.starts_with("core::")).unwrap_or(name);
    let rest = rest.strip_prefix("std::").or_else(|| rest.strip_prefix("core::")).unwrap_or(rest);
    matches!(rest, "include" | "include_str" | "include_bytes")
}

#[derive(Default, Clone)]
struct RustPath { path: Option<String>, dynamic: bool }

#[derive(Default)]
struct RustAttributes { paths: HashMap<usize, RustPath> }

/// Outer attributes belong to the following item.
fn rust_path(node: Node, src: &[u8], cache: &mut RustAttributes) -> RustPath {
    if let Some(cached) = cache.paths.get(&node.id()) { return cached.clone(); }
    let mut result = RustPath::default();
    let mut sibling = node.prev_named_sibling();
    while let Some(s) = sibling {
        sibling = s.prev_named_sibling();
        if s.kind() == "line_comment" || s.kind() == "block_comment" { continue; }
        if s.kind() != "attribute_item" { break; }
        let Some(attribute) = children(s).into_iter().find(|c| c.kind() == "attribute") else { continue };
        let kids = children(attribute);
        let head = kids.first().map(|k| text(*k, src)).unwrap_or("");
        if head == "path" {
            let value = rust_string(kids.iter().find(|c| c.kind() == "string_literal" || c.kind() == "raw_string_literal").copied(), src);
            match value {
                Some(v) if result.path.is_none() => result.path = Some(v),
                _ => result.dynamic = true,
            }
        }
        if head == "cfg_attr" { result.dynamic = true; }
    }
    cache.paths.insert(node.id(), result.clone());
    result
}

/// Decode a Rust string without executing source or interpreting macro tokens.
pub(crate) fn rust_string(node: Option<Node>, src: &[u8]) -> Option<String> {
    let node = node?;
    let source = text(node, src);
    if node.kind() == "raw_string_literal" {
        let rest = source.strip_prefix('r')?;
        let hashes = rest.chars().take_while(|c| *c == '#').count();
        let rest = rest[hashes..].strip_prefix('"')?;
        let close = format!("\"{}", "#".repeat(hashes));
        return rest.strip_suffix(close.as_str()).map(str::to_string);
    }
    if node.kind() != "string_literal" { return None; }
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut i = 1;
    while i + 1 < chars.len() {
        if chars[i] != '\\' { out.push(chars[i]); i += 1; continue; }
        i += 1;
        let escape = chars[i];
        match escape {
            '\n' => while i + 1 < chars.len() && matches!(chars[i + 1], '\t' | '\n' | '\r' | ' ') { i += 1 },
            'x' => {
                let hex: String = chars.iter().skip(i + 1).take(2).collect();
                let b = hex.as_bytes();
                if b.len() != 2 || !(b'0'..=b'7').contains(&b[0]) || !b[1].is_ascii_hexdigit() { return None; }
                out.push(char::from(u8::from_str_radix(&hex, 16).ok()?));
                i += 2;
            }
            'u' => {
                let rest: String = chars[i + 1..].iter().collect();
                let body = rest.strip_prefix('{')?;
                let end = body.find('}')?;
                let digits = &body[..end];
                if digits.is_empty() || !digits.starts_with(|c: char| c.is_ascii_hexdigit()) || !digits.chars().all(|c| c.is_ascii_hexdigit() || c == '_') { return None; }
                let hex = digits.replace('_', "");
                if hex.is_empty() || hex.len() > 6 { return None; }
                let point = u32::from_str_radix(&hex, 16).ok()?;
                out.push(char::from_u32(point)?);
                i += end + 2;
            }
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            '0' => out.push('\0'),
            '\'' | '"' | '\\' => out.push(escape),
            _ => return None,
        }
        i += 1;
    }
    Some(out)
}

fn go_facts(root: Node, src: &[u8]) -> Vec<Value> {
    nodes(root, &["import_spec"]).into_iter().filter_map(|node| {
        let spec = static_string(field(node, "path"), src)?;
        if spec.is_empty() { return None; }
        Some(json!({ "kind": "go_import", "spec": spec, "line": line(node) }))
    }).collect()
}

/// `^_G\s*(?:\.\s*require|\[\s*["']require["']\s*\])$`, or bare `require`.
fn loader_target(t: &str) -> bool {
    if t == "require" { return true; }
    let Some(rest) = t.strip_prefix("_G") else { return false };
    let rest = rest.trim_start_matches(is_js_space);
    if let Some(r) = rest.strip_prefix('.') { return r.trim_start_matches(is_js_space) == "require"; }
    let Some(r) = rest.strip_prefix('[') else { return false };
    let r = r.trim_start_matches(is_js_space).trim_end_matches(is_js_space);
    let Some(r) = r.strip_suffix(']') else { return false };
    let r = r.trim_end_matches(is_js_space);
    let b = r.as_bytes();
    b.len() == 9 && matches!(b[0], b'"' | b'\'') && matches!(b[8], b'"' | b'\'') && &r[1..8] == "require"
}

fn lua_facts(root: Node, src: &[u8]) -> Vec<Value> {
    // A file rebinding require is outside this collector's loader model.
    let rebound = nodes(root, &["variable_list", "parameters"]).into_iter().any(|n| children(n).into_iter().any(|c| loader_target(text(c, src))))
        || nodes(root, &["function_declaration"]).into_iter().any(|n| loader_target(field(n, "name").map(|x| text(x, src)).unwrap_or("")))
        || nodes(root, &["function_call"]).into_iter().any(|n| field(n, "name").map(|x| text(x, src)) == Some("rawset")
            && children(field(n, "arguments").unwrap_or(n)).into_iter().any(|c| text(c, src) == "_G"));
    let mut out = Vec::new();
    if rebound { return out; }
    for node in nodes(root, &["function_call"]) {
        if field(node, "name").map(|x| text(x, src)) != Some("require") { continue; }
        let values = field(node, "arguments").map(children).unwrap_or_default();
        let spec = if values.len() == 1 { static_string(Some(values[0]), src) } else { None };
        let shown = spec.clone().unwrap_or_else(|| values.first().map(|v| slice_utf16(text(*v, src), 80)).unwrap_or_else(|| "…".into()));
        let mut fact = json!({ "kind": "lua_require", "spec": shown, "line": line(node) });
        if spec.is_none() { fact["dynamic"] = json!(true); }
        out.push(fact);
    }
    out
}

pub fn module_info(root: Node, src: &[u8], lang: &str) -> Option<Value> {
    match lang {
        "go" => {
            let clause = children(root).into_iter().find(|n| n.kind() == "package_clause")?;
            let name = children(clause).into_iter().find(|n| n.kind() == "package_identifier").map(|n| text(n, src))?;
            if name.is_empty() { return None; }
            Some(json!({ "package": name }))
        }
        "java" => Some(super::java::java_info(root, src)),
        "lua" => {
            let mut lua_paths: Vec<String> = Vec::new();
            for node in nodes(root, &["assignment_statement"]) {
                let kids = children(node);
                let targets = children(kids.iter().find(|c| c.kind() == "variable_list").copied().unwrap_or(node));
                let values = children(kids.iter().find(|c| c.kind() == "expression_list").copied().unwrap_or(node));
                for (index, target) in targets.iter().enumerate() {
                    if remove_whitespace(text(*target, src)) == "package.path" {
                        if let Some(value) = values.get(index) { lua_paths.extend(lua_path_patterns(*value, src)); }
                    }
                }
            }
            if lua_paths.is_empty() { None } else { Some(json!({ "luaPaths": lua_paths })) }
        }
        "rust" => {
            let inline: Vec<Vec<String>> = nodes(root, &["mod_item"]).into_iter().filter(|n| field(*n, "body").is_some())
                .map(|n| mod_scope(Some(n), src)).collect();
            if inline.is_empty() { None } else { Some(json!({ "inlineModules": inline })) }
        }
        _ => None,
    }
}

enum Operand { Literal(String), SelfPath, Dynamic }

fn lua_path_patterns(expression: Node, src: &[u8]) -> Vec<String> {
    fn flatten(node: Option<Node>, src: &[u8], out: &mut Vec<Operand>) {
        let Some(node) = node else { out.push(Operand::Dynamic); return };
        if node.kind() == "binary_expression" && node.child(1).map(|c| c.kind()) == Some("..") {
            flatten(field(node, "left"), src, out);
            flatten(field(node, "right"), src, out);
            return;
        }
        let literal = if node.kind() == "string" { static_string(Some(node), src) } else { None };
        out.push(match literal {
            Some(l) => Operand::Literal(l),
            None if remove_whitespace(text(node, src)) == "package.path" => Operand::SelfPath,
            None => Operand::Dynamic,
        });
    }
    let mut operands = Vec::new();
    flatten(Some(expression), src, &mut operands);
    let joined: String = operands.iter().map(|o| match o { Operand::Literal(l) => l.as_str(), Operand::SelfPath => ";", Operand::Dynamic => "\0" }).collect();
    joined.split(';').filter(|s| !s.is_empty() && !s.contains('\0') && s.contains('?') && s.ends_with(".lua")).map(str::to_string).collect()
}

/// JavaScript `/\b<name>\b/` (ASCII word characters).
fn has_word(haystack: &str, name: &str) -> bool {
    let word = |b: Option<&u8>| b.is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_');
    let h = haystack.as_bytes();
    let n = name.as_bytes();
    if n.is_empty() { return false; }
    let mut start = 0;
    while let Some(found) = haystack[start..].find(name) {
        let at = start + found;
        let end = at + n.len();
        let before = at.checked_sub(1).and_then(|i| h.get(i));
        let left = word(before) != word(n.first());
        let right = word(n.last()) != word(h.get(end));
        if left && right { return true; }
        start = at + haystack[at..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

fn python_dynamic(root: Node, src: &[u8]) -> Vec<Value> {
    // Insertion-ordered so deletion during iteration mirrors the JS Map.
    let mut loaders: Vec<(String, &'static str)> = vec![("__import__".into(), "function")];
    let set = |loaders: &mut Vec<(String, &'static str)>, key: String, kind: &'static str| {
        if let Some(entry) = loaders.iter_mut().find(|(k, _)| *k == key) { entry.1 = kind } else { loaders.push((key, kind)) }
    };
    for node in children(root) {
        if node.kind() == "import_statement" {
            for entry in children(node) {
                let name = if entry.kind() == "aliased_import" { field(entry, "name") } else { Some(entry) };
                if name.map(|n| text(n, src)) == Some("importlib") {
                    let key = field(entry, "alias").map(|a| text(a, src).to_string()).unwrap_or_else(|| "importlib".into());
                    set(&mut loaders, key, "module");
                }
            }
        }
        if node.kind() == "import_from_statement" && field(node, "module_name").map(|m| text(m, src)) == Some("importlib") {
            for entry in children(node) {
                let name = if entry.kind() == "aliased_import" { field(entry, "name") } else { Some(entry) };
                if name.map(|n| text(n, src)) == Some("import_module") {
                    let key = field(entry, "alias").map(|a| text(a, src).to_string()).unwrap_or_else(|| "import_module".into());
                    set(&mut loaders, key, "function");
                }
            }
        }
    }
    for node in nodes(root, &["import_statement", "import_from_statement"]) {
        let module_node = field(node, "module_name");
        let module = module_node.map(|m| text(m, src));
        for entry in children(node) {
            let original = if entry.kind() == "aliased_import" { field(entry, "name").map(|n| text(n, src)) } else { Some(text(entry, src)) };
            let binding = field(entry, "alias").map(|a| text(a, src)).or_else(|| original.map(|o| o.split('.').next().unwrap_or("")));
            let supported = node.parent().map(|p| p.kind()) == Some("module")
                && (node.kind() == "import_statement" && original == Some("importlib")
                    || node.kind() == "import_from_statement" && module == Some("importlib") && original == Some("import_module"));
            if let Some(binding) = binding {
                if !binding.is_empty() && !supported && Some(entry.id()) != module_node.map(|m| m.id()) {
                    loaders.retain(|(k, _)| k != binding);
                }
            }
        }
    }
    // Any local binding of a loader name makes it ambiguous.
    const BINDERS: &[&str] = &["assignment", "augmented_assignment", "named_expression", "function_definition", "class_definition", "parameters", "lambda_parameters", "for_statement", "for_in_clause", "as_pattern_target", "delete_statement"];
    for node in nodes(root, BINDERS) {
        let target = field(node, "left").or_else(|| field(node, "name"))
            .or_else(|| ["parameters", "lambda_parameters", "as_pattern_target", "delete_statement"].contains(&node.kind()).then_some(node));
        if let Some(target) = target {
            let t = text(target, src);
            loaders.retain(|(name, _)| !has_word(t, name));
        }
    }
    let get = |key: &str| loaders.iter().find(|(k, _)| k == key).map(|(_, v)| *v);
    let mut out = Vec::new();
    for node in nodes(root, &["call"]) {
        let callee = field(node, "function");
        let object = callee.and_then(|c| field(c, "object")).map(|o| text(o, src));
        let recognized = callee.is_some_and(|c| c.kind() == "identifier" && get(text(c, src)) == Some("function")
            || c.kind() == "attribute" && object.is_some_and(|o| !o.is_empty() && get(o) == Some("module"))
                && field(c, "attribute").map(|a| text(a, src)) == Some("import_module"));
        if !recognized { continue; }
        let values = field(node, "arguments").map(children).unwrap_or_default();
        let builtin = callee.map(|c| text(c, src)) == Some("__import__");
        let spec = if !values.is_empty() && values.len() <= if builtin { 1 } else { 2 } { static_string(Some(values[0]), src) } else { None };
        let pkg = if values.len() == 2 { static_string(Some(values[1]), src) } else { None };
        let supported = spec.as_deref().is_some_and(|s| dotted(s.trim_start_matches('.')) && (!s.starts_with('.') || pkg.as_deref().is_some_and(dotted)));
        let shown = spec.clone().unwrap_or_else(|| values.first().map(|v| slice_utf16(text(*v, src), 80)).unwrap_or_else(|| "…".into()));
        let mut fact = Map::new();
        fact.insert("kind".into(), json!("python_dynamic"));
        fact.insert("spec".into(), json!(shown));
        fact.insert("line".into(), json!(line(node)));
        if let Some(p) = pkg.filter(|p| !p.is_empty()) { fact.insert("package".into(), json!(p)); }
        if !supported { fact.insert("dynamic".into(), json!(true)); }
        out.push(Value::Object(fact));
    }
    out
}

/// `[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*`
fn dotted(s: &str) -> bool {
    !s.is_empty() && s.split('.').all(|part| {
        let mut chars = part.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}
