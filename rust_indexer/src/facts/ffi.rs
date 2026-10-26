//! Port of src/ffi-facts.ts: source declarations of native boundaries.

use super::{children, field, line, nodes, static_string, strip_r_hash, text};
use serde_json::{json, Map, Value};
use tree_sitter::Node;

fn attributes(node: Node, src: &[u8]) -> Vec<String> {
    let mut result = Vec::new();
    let mut previous = node.prev_named_sibling();
    while let Some(p) = previous {
        if p.kind() == "attribute_item" { result.push(text(p, src).to_string()); }
        else if !matches!(p.kind(), "line_comment" | "block_comment" | "comment") { break; }
        previous = p.prev_named_sibling();
    }
    result
}

/// `^#\[\s*(?:unsafe\(\s*)?no_mangle\s*\)?\s*\]$`
fn is_no_mangle(attr: &str) -> bool {
    let Some(body) = attr.strip_prefix("#[").and_then(|b| b.strip_suffix(']')) else { return false };
    let body = body.trim();
    let body = body.strip_prefix("unsafe(").map(str::trim_start).unwrap_or(body);
    body.strip_prefix("no_mangle").map(str::trim_start).is_some_and(|b| b.is_empty() || b == ")")
}

/// `^#\[\s*(?:unsafe\(\s*)?(export_name|link_name)\s*=\s*"([^"\\\r\n]+)"\s*\)?\s*\]$`
fn rename(attr: &str) -> Option<(&'static str, String)> {
    let body = attr.strip_prefix("#[")?.strip_suffix(']')?.trim();
    let body = body.strip_prefix("unsafe(").map(str::trim_start).unwrap_or(body);
    let (key, rest) = if let Some(r) = body.strip_prefix("export_name") { ("export_name", r) }
        else if let Some(r) = body.strip_prefix("link_name") { ("link_name", r) } else { return None };
    let rest = rest.trim_start().strip_prefix('=')?.trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    let value = &rest[..end];
    if value.is_empty() || value.contains(['\\', '\r', '\n']) { return None; }
    let tail = rest[end + 1..].trim();
    (tail.is_empty() || tail == ")").then(|| (key, value.to_string()))
}

pub fn ffi_facts(root: Node, src: &[u8], lang: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut emit = |node: Node, symbol: &str, name: &str, kind: &str, abi: Option<&str>| {
        let ln = line(node);
        if name.is_empty() || out.iter().any(|f| f["name"] == name && f["line"] == ln && f["kind"] == kind) { return; }
        let mut fact = Map::new();
        fact.insert("name".into(), json!(name));
        fact.insert("symbol".into(), json!(symbol));
        fact.insert("line".into(), json!(ln));
        fact.insert("lang".into(), json!(lang));
        fact.insert("kind".into(), json!(kind));
        if let Some(abi) = abi.filter(|a| !a.is_empty()) { fact.insert("abi".into(), json!(abi)); }
        out.push(Value::Object(fact));
    };
    match lang {
        "rust" => {
            for node in nodes(root, &["function_item", "function_signature_item", "static_item"]) {
                let Some(symbol) = field(node, "name").map(|n| strip_r_hash(text(n, src))).filter(|s| !s.is_empty()) else { continue };
                let attrs = attributes(node, src);
                let exported = attrs.iter().any(|a| is_no_mangle(a));
                let renamed = attrs.iter().find_map(|a| rename(a));
                let modifiers = children(node).into_iter().find(|c| c.kind() == "function_modifiers");
                let mut abi: Option<String> = modifiers.and_then(|m| nodes(m, &["extern_modifier"]).first().copied())
                    .and_then(|e| static_string(children(e).into_iter().find(|i| i.kind() == "string_literal"), src));
                let mut foreign = false;
                let mut parent = node.parent();
                while let Some(p) = parent {
                    if p.kind() == "foreign_mod_item" {
                        foreign = true;
                        abi = Some(children(p).into_iter().find(|c| c.kind() == "extern_modifier")
                            .and_then(|e| static_string(children(e).into_iter().find(|i| i.kind() == "string_literal"), src))
                            .unwrap_or_else(|| "C".into()));
                    }
                    parent = p.parent();
                }
                let renamed_to = renamed.as_ref().map(|(_, v)| v.as_str());
                if exported || renamed.as_ref().is_some_and(|(k, _)| *k == "export_name") {
                    emit(node, &symbol, renamed_to.unwrap_or(&symbol), "source-export", abi.as_deref());
                } else if foreign {
                    emit(node, &symbol, renamed_to.unwrap_or(&symbol), "foreign-declaration", Some(abi.as_deref().unwrap_or("C")));
                } else if matches!(abi.as_deref(), Some("C") | Some("system")) {
                    emit(node, &symbol, &symbol, "c-linkage-definition", abi.as_deref());
                }
            }
        }
        "c" | "cpp" => {
            for node in nodes(root, &["function_definition", "declaration"]) {
                let mut cursor = node.walk();
                let declarators: Vec<Node> = node.children_by_field_name("declarator", &mut cursor).collect();
                for declarator in declarators {
                    let function = if declarator.kind() == "function_declarator" { Some(declarator) } else { nodes(declarator, &["function_declarator"]).first().copied() };
                    let Some(function) = function else { continue };
                    let mut name = field(function, "declarator");
                    while let Some(inner) = name.and_then(|n| field(n, "declarator")) { name = Some(inner); }
                    let Some(name) = name.filter(|n| n.kind() == "identifier" || n.kind() == "qualified_identifier") else { continue };
                    let mut c_linkage = false;
                    let mut parent = node.parent();
                    while let Some(p) = parent {
                        if p.kind() == "linkage_specification" {
                            c_linkage = static_string(field(p, "value"), src).as_deref() == Some("C");
                            break; // The innermost language linkage overrides an outer block.
                        }
                        parent = p.parent();
                    }
                    let dllexport = children(node).into_iter().any(|c| c.kind() == "ms_declspec_modifier" && children(c).into_iter().any(|i| text(i, src) == "dllexport"));
                    let n = text(name, src);
                    if dllexport { emit(node, n, n, "source-export", c_linkage.then_some("C")); }
                    else if c_linkage { emit(node, n, n, if node.kind() == "function_definition" { "c-linkage-definition" } else { "c-linkage-declaration" }, Some("C")); }
                }
            }
            const REGISTRATIONS: &[&str] = &["NODE_API_MODULE", "NAPI_MODULE", "NAPI_MODULE_X", "NODE_MODULE", "NODE_MODULE_CONTEXT_AWARE", "NODE_MODULE_LINKED"];
            for node in nodes(root, &["call_expression"]) {
                let function = field(node, "function").map(|f| text(f, src)).unwrap_or("");
                if !REGISTRATIONS.contains(&function) { continue; }
                let mut definition = false;
                let mut parent = node.parent();
                while let Some(p) = parent {
                    if p.kind() == "preproc_def" || p.kind() == "preproc_function_def" { definition = true; }
                    parent = p.parent();
                }
                if definition { continue; }
                let first = field(node, "arguments").and_then(|a| children(a).into_iter().next());
                let api = if function.starts_with("NODE_MODULE") { "Node" } else { "N-API" };
                if let Some(name) = first.filter(|n| n.kind() == "identifier") {
                    let t = text(name, src);
                    emit(node, t, t, "module-registration", Some(api));
                }
            }
        }
        "go" => {
            let cgo = nodes(root, &["import_spec"]).into_iter().any(|n| static_string(field(n, "path"), src).as_deref() == Some("C"));
            if cgo {
                for node in nodes(root, &["function_declaration"]) {
                    let Some(name) = field(node, "name").map(|n| text(n, src)).filter(|n| !n.is_empty()) else { continue };
                    let previous = node.prev_named_sibling();
                    if let Some(prev) = previous {
                        if prev.kind() == "comment" && text(prev, src) == format!("//export {name}") && prev.end_position().row + 1 == node.start_position().row {
                            emit(node, name, name, "source-export", Some("cgo"));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    out
}
