//! Port of src/java-facts.ts: Java type syntax and module descriptors.

use super::{all_children, children, field, line, nodes, remove_whitespace, text};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use tree_sitter::Node;

const DECLARATIONS: &[&str] = &["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"];
const TYPE_NODES: &[&str] = &["type_identifier", "scoped_type_identifier", "generic_type"];

fn type_name(node: Node, src: &[u8]) -> Option<String> {
    match node.kind() {
        "type_identifier" => Some(text(node, src).to_string()),
        "generic_type" => children(node).into_iter().find(|c| TYPE_NODES.contains(&c.kind())).and_then(|base| type_name(base, src)),
        "scoped_type_identifier" => {
            let parts: Vec<Option<String>> = children(node).into_iter().filter(|c| TYPE_NODES.contains(&c.kind())).map(|c| type_name(c, src)).collect();
            // JS `parts.every(Boolean)` also rejects empty names.
            if parts.is_empty() || parts.iter().any(|p| p.as_deref().is_none_or(str::is_empty)) { return None; }
            Some(parts.into_iter().flatten().collect::<Vec<_>>().join("."))
        }
        _ => None,
    }
}

fn class_scope(node: Node, src: &[u8]) -> Vec<String> {
    let mut scope = Vec::new();
    let mut parent = node.parent();
    while let Some(p) = parent {
        if DECLARATIONS.contains(&p.kind()) {
            if let Some(name) = field(p, "name").map(|n| text(n, src)).filter(|n| !n.is_empty()) { scope.insert(0, name.to_string()); }
        }
        parent = p.parent();
    }
    scope
}

fn has_ancestor(node: Node, kinds: &[&str]) -> bool {
    let mut parent = node.parent();
    while let Some(p) = parent {
        if kinds.contains(&p.kind()) { return true; }
        parent = p.parent();
    }
    false
}

/// Names of local classes cannot be imported from another file.
fn local_classes(root: Node, src: &[u8]) -> HashSet<String> {
    nodes(root, DECLARATIONS).into_iter()
        .filter(|n| has_ancestor(*n, &["block", "constructor_body", "lambda_expression", "object_creation_expression", "enum_constant"]))
        .filter_map(|n| field(n, "name").map(|x| text(x, src).to_string())).filter(|n| !n.is_empty()).collect()
}

fn shadowed(node: Node, name: &str, locals: &HashSet<String>, cache: &mut HashMap<usize, HashSet<String>>, src: &[u8]) -> bool {
    if locals.contains(name) { return true; }
    let mut current = Some(node);
    while let Some(p) = current {
        let names = cache.entry(p.id()).or_insert_with(|| {
            let parameters = field(p, "type_parameters").or_else(|| children(p).into_iter().find(|c| c.kind() == "type_parameters"));
            parameters.map(|ps| children(ps).into_iter()
                .filter_map(|param| children(param).into_iter().find(|c| c.kind() == "type_identifier").map(|c| text(c, src).to_string()))
                .filter(|n| !n.is_empty()).collect()).unwrap_or_default()
        });
        if names.contains(name) { return true; }
        current = p.parent();
    }
    false
}

fn type_role(node: Node) -> Option<&'static str> {
    let mut current = Some(node);
    while let Some(p) = current {
        match p.kind() {
            "type_bound" => return Some("bound"),
            "superclass" | "extends_interfaces" => return Some("extends"),
            "super_interfaces" => return Some("implements"),
            "field_declaration" | "constant_declaration" => return Some("field"),
            "formal_parameter" | "spread_parameter" | "receiver_parameter" => return Some("parameter"),
            "throws" => return Some("throws"),
            "object_creation_expression" => return Some("construction"),
            "local_variable_declaration" | "cast_expression" | "instanceof_expression" | "array_creation_expression" => return Some("type"),
            "method_declaration" | "annotation_type_element_declaration" => return Some("return"),
            "block" => return None,
            _ => {}
        }
        current = p.parent();
    }
    None
}

fn anonymous_body(node: Node) -> bool {
    let mut parent = node.parent();
    while let Some(p) = parent {
        if p.kind() == "class_body" && p.parent().is_some_and(|g| g.kind() == "object_creation_expression" || g.kind() == "enum_constant") { return true; }
        parent = p.parent();
    }
    false
}

pub fn java_facts(root: Node, src: &[u8]) -> Vec<Value> {
    let mut out = Vec::new();
    let locals = local_classes(root, src);
    let mut parameters = HashMap::new();
    for node in nodes(root, &["import_declaration"]) {
        let kids = children(node);
        if let Some(name) = kids.iter().find(|c| c.kind() == "scoped_identifier" || c.kind() == "identifier") {
            out.push(json!({ "kind": "java_import", "spec": remove_whitespace(text(*name, src)), "line": line(node),
                "static": all_children(node).iter().any(|c| c.kind() == "static"), "wildcard": kids.iter().any(|c| c.kind() == "asterisk") }));
        }
    }
    let mut seen = HashSet::new();
    for atom in nodes(root, &["type_identifier"]) {
        let mut node = atom;
        while let Some(parent) = node.parent() {
            let climbs = parent.kind() == "scoped_type_identifier"
                || parent.kind() == "generic_type" && children(parent).into_iter().find(|c| TYPE_NODES.contains(&c.kind())).map(|c| c.id()) == Some(node.id());
            if !climbs { break; }
            node = parent;
        }
        if !seen.insert(node.id()) { continue; }
        if anonymous_body(node) { continue; }
        if node.parent().is_some_and(|p| p.kind() == "type_parameter" && children(p).first().map(|c| c.id()) == Some(node.id())) { continue; }
        let (Some(spec), Some(role)) = (type_name(node, src), type_role(node)) else { continue };
        if spec.is_empty() { continue; }
        let head = spec.split('.').next().unwrap_or("").to_string();
        if shadowed(node, &head, &locals, &mut parameters, src) { continue; }
        out.push(json!({ "kind": "java_type", "spec": spec, "role": role, "scope": class_scope(node, src), "line": line(node) }));
    }
    for directive in nodes(root, &["requires_module_directive", "exports_module_directive", "opens_module_directive", "uses_module_directive", "provides_module_directive"]) {
        let names: Vec<Node> = children(directive).into_iter().filter(|n| n.kind() == "identifier" || n.kind() == "scoped_identifier").collect();
        if names.is_empty() { continue; }
        let ln = line(directive);
        match directive.kind() {
            "requires_module_directive" => out.push(json!({ "kind": "java_requires", "spec": remove_whitespace(text(names[0], src)), "line": ln })),
            "exports_module_directive" | "opens_module_directive" => out.push(json!({ "kind": "java_package", "spec": remove_whitespace(text(names[0], src)),
                "role": if directive.kind() == "exports_module_directive" { "exports" } else { "opens" }, "line": ln })),
            kind => {
                let role = if kind == "uses_module_directive" { "uses" } else { "provides" };
                for name in names {
                    out.push(json!({ "kind": "java_type", "spec": remove_whitespace(text(name, src)), "role": role, "scope": [], "line": ln }));
                }
            }
        }
    }
    out.sort_by_key(super::line_of);
    out
}

pub fn java_info(root: Node, src: &[u8]) -> Value {
    let top = children(root);
    let pkg = top.iter().find(|n| n.kind() == "package_declaration")
        .and_then(|d| children(*d).into_iter().find(|n| n.kind() == "scoped_identifier" || n.kind() == "identifier"))
        .map(|n| text(n, src)).filter(|t| !t.is_empty());
    let classes: Vec<String> = top.iter().filter(|n| DECLARATIONS.contains(&n.kind()))
        .filter_map(|n| field(*n, "name").map(|x| text(x, src).to_string())).filter(|n| !n.is_empty()).collect();
    let stable: Vec<Node> = nodes(root, DECLARATIONS).into_iter().filter(|node| {
        if has_ancestor(*node, &["block", "constructor_body", "lambda_expression", "object_creation_expression"]) { return false; }
        // Only top-level and directly nested member declarations have stable FQNs.
        let mut parent = node.parent();
        while let Some(p) = parent.filter(|p| ["class_body", "interface_body", "enum_body", "enum_body_declarations"].contains(&p.kind())) { parent = p.parent(); }
        parent.is_some_and(|p| p.kind() == "program" || DECLARATIONS.contains(&p.kind()))
    }).collect();
    let declared = |node: Node| -> String {
        let mut parts = class_scope(node, src);
        if let Some(name) = field(node, "name").map(|n| text(n, src)).filter(|n| !n.is_empty()) { parts.push(name.to_string()); }
        parts.join(".")
    };
    let types: Vec<String> = stable.iter().map(|n| declared(*n)).collect();
    let parents: Vec<Value> = stable.iter().filter_map(|node| {
        let names: Vec<String> = children(*node).into_iter().filter(|c| ["superclass", "super_interfaces", "extends_interfaces"].contains(&c.kind()))
            .flat_map(|container| children(container).into_iter().flat_map(|c| if c.kind() == "type_list" { children(c) } else { vec![c] }))
            .filter_map(|c| type_name(c, src)).filter(|n| !n.is_empty()).collect();
        (!names.is_empty()).then(|| json!({ "name": declared(*node), "types": names }))
    }).collect();
    let module_name = top.iter().find(|n| n.kind() == "module_declaration")
        .and_then(|m| children(*m).into_iter().find(|n| n.kind() == "identifier" || n.kind() == "scoped_identifier"))
        .map(|n| text(n, src)).filter(|t| !t.is_empty());
    let mut info = Map::new();
    info.insert("package".into(), json!(pkg.map(remove_whitespace).unwrap_or_default()));
    info.insert("classes".into(), json!(classes));
    info.insert("javaTypes".into(), json!(types));
    if !parents.is_empty() { info.insert("javaParents".into(), Value::Array(parents)); }
    if let Some(m) = module_name { info.insert("javaModule".into(), json!(remove_whitespace(m))); }
    Value::Object(info)
}
