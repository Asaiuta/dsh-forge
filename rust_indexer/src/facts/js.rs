//! Port of the JS-family `FactsCollector` in src/facts.ts: three passes —
//! top-level const/alias tables, wrapper definitions, then the full fact walk.
//! Trace always extracts with `bridgeGlobals = null` (bridge membership is
//! applied afterwards by `selectBridgeFacts`), so every member access whose
//! base is a plain identifier becomes a bridge fact here.
//!
//! The TS walk runs over a node view whose `children` are the named children,
//! except for leaf-like kinds (TERMINAL) that report none; `kids` mirrors that.

use super::{children as named, field, is_js_space, line, nodes, slice_utf16, text};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tree_sitter::Node;

const TERMINAL: &[&str] = &["identifier", "property_identifier", "private_property_identifier",
    "shorthand_property_identifier", "shorthand_property_identifier_pattern", "string", "number", "regex",
    "true", "false", "null", "this", "super", "comment"];
const FUNCTION_NODES: &[&str] = &["arrow_function", "function_expression", "function", "generator_function"];
const REGISTER_METHODS: &[&str] = &["handle", "on", "once", "addHandler", "removeHandler"];
/// Deeper trees fall back to the WASM path (whose own recursion has a limit).
const MAX_DEPTH: usize = 1500;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileFacts {
    #[serde(skip_serializing_if = "Option::is_none")]
    ambient_modules: Option<Vec<Ambient>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preloads: Option<Vec<Preload>>,
    requires: Vec<Require>,
    imports: Vec<Require>,
    ipc: Vec<Ipc>,
    bridge: Vec<Bridge>,
    bridge_aliases: Vec<Alias>,
    globals_defined: Vec<GlobalDef>,
    globals_used: Vec<GlobalUse>,
    exposes: Vec<Expose>,
    #[serde(skip_serializing_if = "Option::is_none")]
    const_strings: Option<serde_json::Map<String, Value>>,
    wrappers: Vec<Wrapper>,
    bindings: Vec<Binding>,
    deferred_calls: Vec<Deferred>,
    named_entries: Vec<NamedEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    module_exports: Option<ModuleExports>,
}

#[derive(Serialize)]
struct Ambient { name: String, line: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preload {
    spec: String,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    literal: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    external_ref: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Require {
    spec: String,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    dynamic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unresolved: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    import_equals: Option<bool>,
}

#[derive(Serialize)]
struct Ipc {
    side: &'static str,
    method: String,
    channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expr: Option<String>,
    via: &'static str,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
}

#[derive(Serialize)]
struct Bridge {
    object: String,
    name: String,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Alias { name: String, object: String, line: u64, top_level: bool }

#[derive(Serialize)]
struct GlobalDef {
    name: String,
    how: &'static str,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
}

#[derive(Serialize)]
struct GlobalUse {
    name: String,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Expose {
    name: String,
    keys: Vec<String>,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    dynamic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    partial: Option<bool>,
}

#[derive(Serialize)]
struct Wrapper { name: String, side: &'static str, method: String }

/// One imported binding, tagged with the 1-based line of the statement that
/// created it. The line is what lets a link edge report only its own
/// statement's names: a file may import from one module several times, and a
/// per-module name set would make each edge claim the other's names.
#[derive(Serialize, Clone)]
struct Binding { local: String, spec: String, imported: Option<String>, line: u64 }

#[derive(Serialize)]
struct Deferred {
    local: String,
    spec: String,
    imported: Option<String>,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
    channel: String,
    via: &'static str,
}

#[derive(Serialize)]
struct NamedEntry {
    name: String,
    channel: String,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
    spec: Option<String>,
    wrapper: String,
}

#[derive(Serialize, Default)]
struct ModuleExports {
    names: Vec<String>,
    forwards: Vec<Forward>,
    #[serde(skip_serializing_if = "Option::is_none")]
    opaque: Option<Vec<String>>,
}

#[derive(Serialize)]
struct Forward {
    spec: String,
    line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    star: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    names: Option<Vec<ForwardName>>,
}

#[derive(Serialize)]
struct ForwardName { exported: String, imported: String }

#[derive(Clone, Copy)]
struct WrapperDef { side: &'static str }

#[derive(Clone)]
struct Shape { keys: Vec<String>, complete: bool }

#[derive(Clone)]
struct Ctx { owner: Option<String>, params: Option<HashSet<String>> }

const TOP: Ctx = Ctx { owner: None, params: None };

/// A JS `Map` preserves the first insertion position across `set`.
struct OrderedMap<V> { keys: Vec<String>, values: HashMap<String, V> }

impl<V> Default for OrderedMap<V> {
    fn default() -> Self { OrderedMap { keys: Vec::new(), values: HashMap::new() } }
}

impl<V> OrderedMap<V> {
    fn set(&mut self, key: String, value: V) {
        if !self.values.contains_key(&key) { self.keys.push(key.clone()); }
        self.values.insert(key, value);
    }
    fn get(&self, key: &str) -> Option<&V> { self.values.get(key) }
    fn has(&self, key: &str) -> bool { self.values.contains_key(key) }
    fn iter(&self) -> impl Iterator<Item = (&String, &V)> { self.keys.iter().map(|k| (k, &self.values[k])) }
    fn len(&self) -> usize { self.keys.len() }
}

/// Extract facts; `None` means the tree is too deep for the native walk.
pub fn js_facts(root: Node, src: &[u8]) -> Option<FileFacts> {
    let mut c = Collector {
        src, out: FileFacts::default(), has_ipc: false, consts: OrderedMap::default(), const_shapes: HashMap::new(),
        wrappers: OrderedMap::default(), wrapper_methods: HashMap::new(), bindings: OrderedMap::default(), local_exports: Vec::new(),
        param_calls: Vec::new(), wrapper_call_sites: HashMap::new(), used_seen: HashSet::new(), too_deep: false,
    };
    let mut cursor = root.walk();
    c.collect(root, &mut cursor);
    (!c.too_deep).then_some(c.out)
}

struct Collector<'a> {
    src: &'a [u8],
    out: FileFacts,
    has_ipc: bool,
    consts: OrderedMap<String>,
    const_shapes: HashMap<String, Shape>,
    wrappers: OrderedMap<WrapperDef>,
    /// IPC method names of wrappers, kept beside the Copy definition.
    wrapper_methods: HashMap<String, String>,
    bindings: OrderedMap<Binding>,
    local_exports: Vec<(String, String, u64)>,
    param_calls: Vec<(usize, String)>,
    wrapper_call_sites: HashMap<String, u32>,
    used_seen: HashSet<String>,
    too_deep: bool,
}

fn kids(node: Node) -> Vec<Node> {
    if TERMINAL.contains(&node.kind()) { Vec::new() } else { named(node) }
}

/// `kids` on a reused cursor: the walk visits every named node, and a fresh
/// TreeCursor per node is a heap allocation each time.
fn kids_with<'t>(node: Node<'t>, cursor: &mut tree_sitter::TreeCursor<'t>) -> Vec<Node<'t>> {
    if TERMINAL.contains(&node.kind()) { Vec::new() } else { node.named_children(cursor).collect() }
}

fn args_of(call: Node) -> Vec<Node> {
    field(call, "arguments").map(|a| named(a).into_iter().filter(|c| c.kind() != "comment").collect()).unwrap_or_default()
}

/// JS `[\w$]` (ASCII).
fn ident_char(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' || c == '$' }
fn ident_start(c: char) -> bool { c.is_ascii_alphabetic() || c == '_' || c == '$' }

/// `^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$`
fn dotted_ident(s: &str) -> bool {
    !s.is_empty() && s.split('.').all(|part| {
        let mut chars = part.chars();
        chars.next().is_some_and(ident_start) && chars.all(ident_char)
    })
}

/// `^(?:[A-Za-z_$][\w$]*\.)*<last>$`
fn ipc_object(obj: &str, last: &str) -> bool {
    match obj.rsplit_once('.') {
        None => obj == last,
        Some((head, tail)) => tail == last && dotted_ident(head),
    }
}

/// `text.length > 80 ? text.slice(0, 77) + '…' : text` in UTF-16 units.
fn truncate(t: &str) -> String {
    if t.encode_utf16().count() > 80 { format!("{}…", slice_utf16(t, 77)) } else { t.to_string() }
}

/// `text.replace(/\[\s*(['"])([^'"\]]+)\1\s*\]/g, '.$2')`
fn normalize_member(t: &str) -> String {
    let chars: Vec<char> = t.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    'outer: while i < chars.len() {
        if chars[i] == '[' {
            let mut j = i + 1;
            while j < chars.len() && is_js_space(chars[j]) { j += 1; }
            if let Some(&q) = chars.get(j).filter(|c| **c == '\'' || **c == '"') {
                let start = j + 1;
                let mut k = start;
                while k < chars.len() && !matches!(chars[k], '\'' | '"' | ']') { k += 1; }
                if k > start && chars.get(k) == Some(&q) {
                    let mut m = k + 1;
                    while m < chars.len() && is_js_space(chars[m]) { m += 1; }
                    if chars.get(m) == Some(&']') {
                        out.push('.');
                        out.extend(&chars[start..k]);
                        i = m + 1;
                        continue 'outer;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn js_trim(s: &str) -> &str { s.trim_matches(is_js_space) }

/// `/^\s*<word>\b/`
fn starts_with_word(t: &str, word: &str) -> bool {
    t.trim_start_matches(is_js_space).strip_prefix(word).is_some_and(|rest| !rest.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// `/(?:window|globalThis)\.([A-Za-z_$][\w$]*)/` — first match anywhere.
fn first_global_member(t: &str) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for prefix in ["window.", "globalThis."] {
        let mut from = 0;
        while let Some(found) = t[from..].find(prefix) {
            let at = from + found;
            if best.as_ref().is_some_and(|(b, _)| *b <= at) { break; }
            let rest = &t[at + prefix.len()..];
            if rest.chars().next().is_some_and(ident_start) {
                best = Some((at, rest.chars().take_while(|c| ident_char(*c)).collect()));
                break;
            }
            from = at + 1;
        }
    }
    best.map(|(_, name)| name)
}

impl<'a> Collector<'a> {
    fn t(&self, node: Node) -> &'a str { text(node, self.src) }

    /// Value of a string-literal-ish node.
    fn literal(&self, node: Option<Node>) -> Option<String> {
        let node = node?;
        let t = self.t(node);
        let inner = |t: &str| {
            let mut chars = t.chars();
            chars.next();
            chars.next_back();
            chars.as_str().to_string()
        };
        match node.kind() {
            "string" if t.encode_utf16().count() >= 2 => Some(inner(t)),
            "template_string" if !t.contains("${") && t.encode_utf16().count() >= 2 => Some(inner(t)),
            _ => None,
        }
    }

    fn property_name(&self, node: Node) -> Option<&'a str> {
        let prop = field(node, "property")?;
        matches!(prop.kind(), "property_identifier" | "identifier" | "private_property_identifier").then(|| self.t(prop))
    }

    fn object_text(&self, node: Node) -> Option<&'a str> { field(node, "object").map(|o| self.t(o)) }

    fn collect<'t>(&mut self, root: Node<'t>, cursor: &mut tree_sitter::TreeCursor<'t>) {
        let source = self.t(root);
        self.has_ipc = source.contains("ipcMain") || source.contains("ipcRenderer") || source.contains("webContents");
        let top = kids(root);
        for stmt in &top { self.scan_top_level(*stmt); }
        // Every ambient_declaration begins with the `declare` keyword.
        if source.contains("declare") && !top.iter().any(|n| n.kind() == "import_statement" || n.kind() == "export_statement") {
            for node in nodes(root, &["ambient_declaration"]) {
                let declaration = kids(node).into_iter().find(|c| c.kind() == "module");
                if let Some(name) = declaration.and_then(|d| self.literal(field(d, "name"))) {
                    if !name.is_empty() && !name.contains('*') { self.out.ambient_modules.get_or_insert_with(Vec::new).push(Ambient { name, line: line(node) }); }
                }
            }
        }
        self.scan_wrappers(root);
        for child in &top { self.walk(*child, &TOP, 0, cursor); }
        for (index, wrapper) in std::mem::take(&mut self.param_calls) {
            if self.wrapper_call_sites.get(&wrapper).copied().unwrap_or(0) == 0 { self.out.ipc[index].via = "dynamic"; }
        }
        for (local, exported, ln) in std::mem::take(&mut self.local_exports) {
            let binding = self.bindings.get(&local).cloned();
            let exports = self.out.module_exports.get_or_insert_with(ModuleExports::default);
            match binding {
                None => if !exports.names.contains(&exported) { exports.names.push(exported) },
                Some(b) => match b.imported {
                    Some(imported) => exports.forwards.push(Forward { spec: b.spec, line: ln, star: None, namespace: None, names: Some(vec![ForwardName { exported, imported }]) }),
                    None => exports.opaque.get_or_insert_with(Vec::new).push(exported),
                },
            }
        }
        let top_level: HashSet<&str> = self.out.globals_defined.iter().map(|d| d.name.as_str()).collect();
        let wrappers: Vec<Wrapper> = self.wrappers.iter().filter(|(name, _)| top_level.contains(name.as_str()))
            .map(|(name, def)| Wrapper { name: name.clone(), side: def.side, method: self.wrapper_methods[name].clone() }).collect();
        self.out.wrappers = wrappers;
        if self.consts.len() > 0 {
            let mut exported = serde_json::Map::new();
            for (name, value) in self.consts.iter() {
                if exported.len() >= 128 { break; }
                if value.encode_utf16().count() > 200 { continue; }
                exported.insert(name.clone(), Value::String(value.clone()));
            }
            self.out.const_strings = Some(exported);
        }
    }

    // ---- pass 1: top-level const channels, aliases, global defs -------------

    fn scan_top_level(&mut self, stmt: Node) {
        match stmt.kind() {
            "export_statement" => {
                self.scan_export(stmt);
                if let Some(inner) = field(stmt, "declaration") { self.scan_top_level(inner); }
            }
            "import_statement" => self.scan_import_bindings(stmt),
            "lexical_declaration" | "variable_declaration" => {
                let t = self.t(stmt);
                let kind = if starts_with_word(t, "const") { "const" } else if starts_with_word(t, "let") { "let" } else { "var" };
                for declarator in kids(stmt).into_iter().filter(|c| c.kind() == "variable_declarator") {
                    let (Some(name), Some(value)) = (field(declarator, "name"), field(declarator, "value")) else { continue };
                    if kind == "const" {
                        self.scan_const_value(self.t(name).to_string(), value, line(declarator), true, 0);
                        self.scan_require_binding(name, value);
                    }
                    if name.kind() == "identifier" {
                        self.out.globals_defined.push(GlobalDef { name: self.t(name).to_string(), how: kind, line: line(declarator), symbol: None });
                    }
                }
            }
            "function_declaration" | "generator_function_declaration" => {
                if let Some(name) = field(stmt, "name") {
                    self.out.globals_defined.push(GlobalDef { name: self.t(name).to_string(), how: "function", line: line(stmt), symbol: None });
                }
            }
            _ => {}
        }
    }

    fn name_of(&self, node: Option<Node>) -> Option<String> {
        let node = node?;
        if node.kind() == "string" { self.literal(Some(node)) } else { Some(self.t(node).to_string()) }
    }

    /// Top-level export statement → declared names or forwards.
    fn scan_export(&mut self, stmt: Node) {
        let ln = line(stmt);
        let source = field(stmt, "source");
        let spec = source.and_then(|s| self.literal(Some(s)));
        if source.is_some() && spec.is_none() { return; }
        let stmt_kids = kids(stmt);
        let clause = stmt_kids.iter().find(|c| c.kind() == "export_clause").copied();
        let specifiers: Vec<(String, String)> = clause.map(kids).unwrap_or_default().into_iter().filter(|c| c.kind() == "export_specifier").filter_map(|child| {
            let imported = self.name_of(field(child, "name"));
            let exported = self.name_of(field(child, "alias")).or_else(|| imported.clone());
            match (imported, exported) { (Some(i), Some(e)) if !i.is_empty() && !e.is_empty() => Some((i, e)), _ => None }
        }).collect();
        let t = self.t(stmt);
        if let Some(spec) = spec {
            let namespace = stmt_kids.iter().find(|c| c.kind() == "namespace_export").copied();
            let forward = if let Some(namespace) = namespace {
                let name = self.name_of(kids(namespace).into_iter().find(|c| c.kind() == "identifier" || c.kind() == "string"));
                name.filter(|n| !n.is_empty()).map(|name| Forward { spec, line: ln, star: None, namespace: Some(name), names: None })
            } else if clause.is_some() {
                Some(Forward { spec, line: ln, star: None, namespace: None, names: Some(specifiers.into_iter().map(|(imported, exported)| ForwardName { exported, imported }).collect()) })
            } else if export_star(t) {
                Some(Forward { spec, line: ln, star: Some(true), namespace: None, names: None })
            } else { None };
            let exports = self.out.module_exports.get_or_insert_with(ModuleExports::default);
            if let Some(f) = forward { exports.forwards.push(f); }
            return;
        }
        self.out.module_exports.get_or_insert_with(ModuleExports::default);
        if clause.is_some() {
            for (imported, exported) in specifiers { self.local_exports.push((imported, exported, ln)); }
            return;
        }
        if t.strip_prefix("export").is_some_and(|r| r.starts_with(is_js_space) && starts_with_word(r, "default")) {
            self.out.module_exports.as_mut().unwrap().names.push("default".into());
            return;
        }
        let mut declared = Vec::new();
        self.declared(field(stmt, "declaration"), &mut declared);
        let exports = self.out.module_exports.as_mut().unwrap();
        for name in declared { if !exports.names.contains(&name) { exports.names.push(name); } }
    }

    fn declared(&self, node: Option<Node>, out: &mut Vec<String>) {
        let Some(node) = node else { return };
        match node.kind() {
            "ambient_declaration" => for child in kids(node) { self.declared(Some(child), out) },
            "lexical_declaration" | "variable_declaration" => {
                for declarator in kids(node).into_iter().filter(|c| c.kind() == "variable_declarator") {
                    let Some(name) = field(declarator, "name") else { continue };
                    if name.kind() == "identifier" { out.push(self.t(name).to_string()); continue; }
                    // Destructuring: every bound identifier is exported.
                    let ids = nodes(name, &["identifier"]).into_iter().chain(nodes(name, &["shorthand_property_identifier_pattern"]));
                    for id in ids {
                        let keep = match id.parent() {
                            Some(p) if p.kind() == "pair_pattern" => field(p, "value").map(|v| v.id()) == Some(id.id()),
                            _ => true,
                        };
                        if keep { out.push(self.t(id).to_string()); }
                    }
                }
            }
            _ => {
                if let Some(name) = field(node, "name").filter(|n| n.kind() == "identifier" || n.kind() == "type_identifier") { out.push(self.t(name).to_string()); }
            }
        }
    }

    /// `const { invoke, send: s } = require('spec')` / `const bridge = require('spec')`.
    fn scan_require_binding(&mut self, name: Node, value: Node) {
        if value.kind() != "call_expression" { return; }
        let callee = field(value, "function");
        if !callee.is_some_and(|c| c.kind() == "identifier" && self.t(c) == "require") { return; }
        let Some(spec) = self.literal(args_of(value).first().copied()) else { return };
        // The call node's own line, matching the require reference the link
        // stage records for the same call.
        let line = value.start_position().row as u64 + 1;
        if name.kind() == "identifier" {
            self.add_binding(Binding { local: self.t(name).to_string(), spec, imported: None, line });
            return;
        }
        if name.kind() != "object_pattern" { return; }
        for child in kids(name) {
            if child.kind() == "shorthand_property_identifier_pattern" {
                let t = self.t(child).to_string();
                self.add_binding(Binding { local: t.clone(), spec: spec.clone(), imported: Some(t), line });
            } else if child.kind() == "pair_pattern" {
                let key = field(child, "key");
                let target = field(child, "value");
                let imported = key.and_then(|k| if k.kind() == "string" { self.literal(Some(k)) } else { Some(self.t(k).to_string()) });
                if let (Some(imported), Some(target)) = (imported.filter(|i| !i.is_empty()), target.filter(|t| t.kind() == "identifier")) {
                    self.add_binding(Binding { local: self.t(target).to_string(), spec: spec.clone(), imported: Some(imported), line });
                }
            }
        }
    }

    /// `import { a, b as c } from 'spec'` / `import * as ns from 'spec'` / `import d from 'spec'`.
    fn scan_import_bindings(&mut self, stmt: Node) {
        let Some(spec) = self.literal(field(stmt, "source")) else { return };
        let Some(clause) = kids(stmt).into_iter().find(|c| c.kind() == "import_clause") else { return };
        // The statement line the import reference is recorded against.
        let line = stmt.start_position().row as u64 + 1;
        let mut stack = vec![clause];
        let mut found = Vec::new();
        // Depth-first in document order, like the recursive TS visitor.
        while let Some(node) = stack.pop() {
            match node.kind() {
                "import_specifier" => {
                    let name = field(node, "name");
                    let alias = field(node, "alias");
                    let imported = name.and_then(|n| if n.kind() == "string" { self.literal(Some(n)) } else { Some(self.t(n).to_string()) });
                    let local = alias.map(|a| self.t(a).to_string()).or_else(|| imported.clone());
                    if let (Some(i), Some(l)) = (imported.filter(|s| !s.is_empty()), local.filter(|s| !s.is_empty())) { found.push(Binding { local: l, spec: spec.clone(), imported: Some(i), line }); }
                }
                "namespace_import" => {
                    if let Some(id) = kids(node).into_iter().find(|c| c.kind() == "identifier") { found.push(Binding { local: self.t(id).to_string(), spec: spec.clone(), imported: None, line }); }
                }
                "identifier" if node.parent().is_some_and(|p| p.kind() == "import_clause") => {
                    found.push(Binding { local: self.t(node).to_string(), spec: spec.clone(), imported: None, line });
                }
                _ => { let mut k = kids(node); k.reverse(); stack.extend(k); }
            }
        }
        for binding in found { self.add_binding(binding); }
    }

    fn add_binding(&mut self, binding: Binding) {
        if self.bindings.has(&binding.local) { return; }
        self.bindings.set(binding.local.clone(), binding.clone());
        self.out.bindings.push(binding);
    }

    /// const NAME = 'lit' | Object.freeze({k: 'lit'}) | {k: 'lit'} | window.Y (alias).
    fn scan_const_value(&mut self, name: String, value: Node, ln: u64, top_level: bool, depth: usize) {
        if depth > MAX_DEPTH { self.too_deep = true; return; }
        match value.kind() {
            "string" | "template_string" => { if let Some(lit) = self.literal(Some(value)) { self.consts.set(name, lit); } }
            "call_expression" => {
                let callee = field(value, "function").map(|c| self.t(c));
                if matches!(callee, Some("Object.freeze") | Some("Object.seal")) {
                    if let Some(arg) = args_of(value).first().copied() { self.scan_const_value(name, arg, ln, top_level, depth + 1); }
                }
            }
            "object" => {
                let shape = self.object_shape(Some(value), 0).expect("object literal shape");
                self.const_shapes.insert(name.clone(), shape);
                for pair in kids(value).into_iter().filter(|c| c.kind() == "pair") {
                    let (Some(key), Some(pair_value)) = (field(pair, "key"), field(pair, "value")) else { continue };
                    let Some(lit) = self.literal(Some(pair_value)) else { continue };
                    if matches!(key.kind(), "property_identifier" | "identifier" | "string") {
                        let key_name = if key.kind() == "string" { self.literal(Some(key)) } else { Some(self.t(key).to_string()) };
                        if let Some(k) = key_name.filter(|k| !k.is_empty()) { self.consts.set(format!("{name}.{k}"), lit); }
                    }
                }
            }
            _ => self.record_bridge_alias(name, value, ln, top_level),
        }
    }

    fn record_bridge_alias(&mut self, name: String, value: Node, ln: u64, top_level: bool) {
        // The kind gate comes first: scanning every declarator's full value text
        // (nested function bodies in bundles) would be quadratic.
        let aliasable = matches!(value.kind(), "binary_expression" | "member_expression" | "await_expression" | "parenthesized_expression" | "identifier");
        let object = if aliasable { first_global_member(self.t(value)) } else { None };
        if let Some(object) = object {
            if self.out.bridge_aliases.iter().any(|a| a.name == name && a.line == ln && a.object == object) { return; }
            self.out.bridge_aliases.push(Alias { name, object, line: ln, top_level });
        } else if value.kind() == "identifier" {
            let source = self.t(value);
            let inherited = self.out.bridge_aliases.iter().find(|a| a.name == source && a.line != ln).map(|a| a.object.clone());
            if let Some(inherited) = inherited {
                if self.out.bridge_aliases.iter().any(|a| a.name == name && a.line == ln && a.object == inherited) { return; }
                self.out.bridge_aliases.push(Alias { name, object: inherited, line: ln, top_level });
                return;
            }
            if let Some(shape) = self.const_shapes.get(source).cloned() { self.const_shapes.insert(name, shape); }
        }
    }

    /// Member names of an exposed object when statically knowable.
    fn object_shape(&mut self, node: Option<Node>, depth: usize) -> Option<Shape> {
        let node = node?;
        if depth > MAX_DEPTH { self.too_deep = true; return None; }
        match node.kind() {
            "parenthesized_expression" => {
                let inner = kids(node).into_iter().next();
                inner.and_then(|i| self.object_shape(Some(i), depth + 1))
            }
            "object" => {
                let mut keys = Vec::new();
                let mut complete = true;
                for entry in kids(node) {
                    match entry.kind() {
                        "pair" => {
                            let key = field(entry, "key");
                            match key.and_then(|k| if k.kind() == "string" { self.literal(Some(k)) } else { Some(self.t(k).to_string()) }) {
                                None => complete = false,
                                Some(name) => keys.push(name),
                            }
                        }
                        "shorthand_property_identifier" | "shorthand_property_identifier_pattern" => keys.push(self.t(entry).to_string()),
                        "method_definition" => if let Some(name) = field(entry, "name") { keys.push(self.t(name).to_string()) },
                        "spread_element" => complete = false,
                        _ => {}
                    }
                }
                Some(Shape { keys, complete })
            }
            "call_expression" => {
                let callee = field(node, "function");
                let method = callee.filter(|c| c.kind() == "member_expression").and_then(|c| self.property_name(c));
                match method {
                    Some("freeze") | Some("seal") => { let first = args_of(node).first().copied(); self.object_shape(first, depth + 1) }
                    Some("assign") => {
                        let parts: Vec<Option<Shape>> = args_of(node).into_iter().map(|a| self.object_shape(Some(a), depth + 1)).collect();
                        if parts.is_empty() || parts.iter().any(Option::is_none) { return None; }
                        let mut keys: Vec<String> = Vec::new();
                        for part in parts.iter().flatten() { for key in &part.keys { if !keys.contains(key) { keys.push(key.clone()); } } }
                        Some(Shape { keys, complete: parts.iter().flatten().all(|p| p.complete) })
                    }
                    _ => None,
                }
            }
            "identifier" => self.const_shapes.get(self.t(node)).cloned(),
            _ => None,
        }
    }

    // ---- pass 2: wrapper definitions (ipc passthrough bodies) ---------------

    fn scan_wrappers(&mut self, root: Node) {
        if !self.has_ipc { return; }
        for node in nodes(root, &["call_expression"]) {
            let Some((side, method)) = self.classify(field(node, "function")) else { continue };
            let Some(arg0) = args_of(node).first().copied().filter(|a| a.kind() == "identifier") else { continue };
            let mut ancestors = Vec::new();
            let mut parent = node.parent();
            while let Some(p) = parent { ancestors.push(p); parent = p.parent(); }
            let mut ctx = TOP;
            for ancestor in ancestors.iter().rev() { if let Some(next) = self.descend(*ancestor, &ctx) { ctx = next; } }
            if let (Some(owner), Some(params)) = (&ctx.owner, &ctx.params) {
                if params.contains(self.t(arg0)) && !self.wrappers.has(owner) { self.set_wrapper(owner.clone(), side, method); }
            }
        }
    }

    fn set_wrapper(&mut self, name: String, side: &'static str, method: String) {
        self.wrapper_methods.insert(name.clone(), method);
        self.wrappers.set(name, WrapperDef { side });
    }

    fn classify(&self, callee: Option<Node>) -> Option<(&'static str, String)> {
        let callee = callee.filter(|c| c.kind() == "member_expression")?;
        let prop = self.property_name(callee)?;
        let obj = self.object_text(callee);
        if let Some(obj) = obj.filter(|o| !o.is_empty()) {
            if ipc_object(obj, "ipcMain") && REGISTER_METHODS.contains(&prop) { return Some(("register", prop.to_string())); }
            if ipc_object(obj, "ipcRenderer") { return Some(("call", prop.to_string())); }
        }
        if prop == "send" {
            let obj_node = field(callee, "object");
            if obj_node.is_some_and(|o| o.kind() == "member_expression" && self.property_name(o) == Some("webContents")) { return Some(("push", "send".into())); }
        }
        None
    }

    // ---- pass 3: full fact walk ----------------------------------------------

    fn walk<'t>(&mut self, node: Node<'t>, ctx: &Ctx, depth: usize, cursor: &mut tree_sitter::TreeCursor<'t>) {
        if depth > MAX_DEPTH { self.too_deep = true; return; }
        if self.too_deep || node.kind() == "comment" { return; }
        let ln = line(node);

        if node.kind() == "variable_declarator" {
            if let (Some(name), Some(value)) = (field(node, "name").filter(|n| n.kind() == "identifier"), field(node, "value")) {
                self.record_bridge_alias(self.t(name).to_string(), value, ln, false);
            }
        }

        // Electron preload wiring (see PreloadFact).
        if node.kind() == "pair" && field(node, "key").is_some_and(|k| k.kind() == "property_identifier" && self.t(k) == "preload") {
            if let Some(fact) = self.preload_fact(field(node, "value")) { self.out.preloads.get_or_insert_with(Vec::new).push(fact); }
        }

        // Import/re-export edges.
        if node.kind() == "import_statement" || node.kind() == "export_statement" {
            let equals = kids(node).into_iter().find(|c| c.kind() == "import_require_clause");
            let source = field(node, "source").or_else(|| equals.and_then(|e| field(e, "source")));
            if let Some(spec) = source.and_then(|s| self.literal(Some(s))) {
                let fact = Require { spec, line: ln, dynamic: None, unresolved: None, import_equals: equals.map(|_| true) };
                if equals.is_some() { self.out.requires.push(fact) } else { self.out.imports.push(fact) }
            }
        }

        let is_call = node.kind() == "call_expression";
        if is_call {
            let callee = field(node, "function");
            self.record_ipc_call(node, ctx);
            let dynamic_import = callee.is_some_and(|c| c.kind() == "import");
            if dynamic_import || callee.is_some_and(|c| c.kind() == "identifier" && self.t(c) == "require") {
                let first = args_of(node).first().copied();
                match self.literal(first) {
                    Some(spec) => self.out.requires.push(Require { spec, line: ln, dynamic: dynamic_import.then_some(true), unresolved: None, import_equals: None }),
                    None => if let Some(arg) = first {
                        self.out.requires.push(Require { spec: truncate(self.t(arg)), line: ln, dynamic: Some(true), unresolved: Some(true), import_equals: None });
                    },
                }
                return;
            }
        }

        // Named function scope for the children.
        let scoped = self.descend(node, ctx);
        let inner = scoped.as_ref().unwrap_or(ctx);

        if node.kind() == "assignment_expression" {
            if let Some(left) = field(node, "left").filter(|l| l.kind() == "member_expression") {
                if matches!(self.object_text(left), Some("window") | Some("globalThis")) {
                    if let Some(name) = self.property_name(left).filter(|n| !n.is_empty()) {
                        self.out.globals_defined.push(GlobalDef { name: name.to_string(), how: "window", line: ln, symbol: ctx.owner.clone() });
                    }
                }
            }
        }

        if node.kind() == "member_expression" { self.record_member(node, ctx); }
        // The WASM grammar parses `import.meta` as a member access of `import`;
        // newer grammars have meta_property. Keep the WASM fact (never a bridge
        // global downstream, but byte parity keeps the two paths interchangeable).
        if node.kind() == "meta_property" && self.t(node) == "import.meta" {
            self.out.bridge.push(Bridge { object: "import".into(), name: "meta".into(), line: ln, symbol: ctx.owner.clone() });
        }

        // `name: <wrapper>('channel')` — the preload API key → channel pair.
        if node.kind() == "pair" {
            if let Some((call, spec, wrapper)) = field(node, "value").and_then(|v| self.wrapper_call_within(v)) {
                let key = field(node, "key");
                let name = key.and_then(|k| match k.kind() {
                    "string" => self.literal(Some(k)),
                    "property_identifier" | "identifier" => Some(self.t(k).to_string()),
                    _ => None,
                });
                if let (Some(name), Some((channel, _))) = (name, self.resolve_channel(args_of(call).first().copied())) {
                    self.out.named_entries.push(NamedEntry { name, channel, line: ln, symbol: ctx.owner.clone(), spec, wrapper });
                }
            }
        }

        // contextBridge.exposeInMainWorld('name', value).
        if is_call {
            if let Some(callee) = field(node, "function").filter(|c| c.kind() == "member_expression") {
                if self.property_name(callee) == Some("exposeInMainWorld") {
                    let args = args_of(node);
                    let literal = self.literal(args.first().copied());
                    let identifier = args.first().filter(|a| a.kind() == "identifier").map(|a| self.t(*a).to_string());
                    if let Some(name) = literal.clone().or(identifier) {
                        let table = args.get(1).copied();
                        let shape = self.object_shape(table, 0);
                        let known = shape.as_ref().is_some_and(|s| !s.keys.is_empty() || table.is_some_and(|t| t.kind() == "object"));
                        self.out.exposes.push(Expose {
                            name,
                            keys: shape.as_ref().map(|s| s.keys.clone()).unwrap_or_default(),
                            line: ln,
                            dynamic: literal.is_none().then_some(true),
                            key_source: known.then(|| if table.is_some_and(|t| t.kind() == "identifier") { "identifier" } else { "literal" }),
                            partial: shape.as_ref().is_some_and(|s| !s.complete).then_some(true),
                        });
                    }
                }
            }
        }

        for child in kids_with(node, cursor) { self.walk(child, inner, depth + 1, cursor); }
    }

    /// Scope context for the children of `node` (named functions and arrow
    /// consts); `None` keeps the current context.
    fn descend(&self, node: Node, ctx: &Ctx) -> Option<Ctx> {
        match node.kind() {
            "function_declaration" | "generator_function_declaration" | "method_definition" => {
                let owner = field(node, "name").map(|n| self.t(n).to_string()).or_else(|| ctx.owner.clone());
                Some(Ctx { owner, params: Some(self.function_params(node)) })
            }
            "variable_declarator" => {
                let name = field(node, "name").filter(|n| n.kind() == "identifier")?;
                let value = field(node, "value").filter(|v| FUNCTION_NODES.contains(&v.kind()))?;
                Some(Ctx { owner: Some(self.t(name).to_string()), params: Some(self.function_params(value)) })
            }
            _ => None,
        }
    }

    fn function_params(&self, node: Node) -> HashSet<String> {
        let mut names = HashSet::new();
        let Some(params) = field(node, "parameters") else { return names };
        let mut stack: Vec<Node> = named(params);
        while let Some(param) = stack.pop() {
            if matches!(param.kind(), "identifier" | "shorthand_property_identifier_pattern") { names.insert(self.t(param).to_string()); }
            else { stack.extend(kids(param)); }
        }
        names
    }

    fn record_member(&mut self, node: Node, ctx: &Ctx) {
        let Some(obj) = self.object_text(node).filter(|o| !o.is_empty()) else { return };
        // Assignment LHS is a definition site, not a use.
        if let Some(parent) = node.parent() {
            if parent.kind() == "assignment_expression" && field(parent, "left").map(|l| l.id()) == Some(node.id()) { return; }
        }
        if obj == "window" || obj == "globalThis" {
            if let Some(name) = self.property_name(node).filter(|n| !n.is_empty()) {
                let key = format!("{name}:{}", node.start_position().row);
                if self.used_seen.insert(key) {
                    self.out.globals_used.push(GlobalUse { name: name.to_string(), line: line(node), symbol: ctx.owner.clone() });
                }
            }
            return;
        }
        let base = obj.strip_prefix("window.").or_else(|| obj.strip_prefix("globalThis.")).unwrap_or(obj);
        if !base.is_empty() && base.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
            if let Some(name) = self.property_name(node).filter(|n| !n.is_empty()) {
                self.out.bridge.push(Bridge { object: base.to_string(), name: name.to_string(), line: line(node), symbol: ctx.owner.clone() });
            }
        }
    }

    fn record_ipc_call(&mut self, node: Node, ctx: &Ctx) {
        let Some(callee) = field(node, "function") else { return };
        let ln = line(node);
        if callee.kind() == "identifier" {
            let name = self.t(callee);
            // Call through a same-file wrapper: real channel comes from the argument.
            if let Some(def) = self.wrappers.get(name).copied() {
                if let Some((channel, _)) = self.resolve_channel(args_of(node).first().copied()) {
                    *self.wrapper_call_sites.entry(name.to_string()).or_insert(0) += 1;
                    self.out.ipc.push(Ipc { side: def.side, method: self.wrapper_methods[name].clone(), channel: Some(channel), expr: None, via: "wrapper", line: ln, symbol: ctx.owner.clone() });
                }
                return;
            }
            // Call through an imported wrapper: deferred until the graph pass.
            if let Some(binding) = self.bindings.get(name).cloned() {
                if let Some((channel, via)) = self.resolve_channel(args_of(node).first().copied()) {
                    self.out.deferred_calls.push(Deferred { local: binding.local, spec: binding.spec, imported: binding.imported, line: ln, symbol: ctx.owner.clone(), channel, via });
                }
            }
        }
        if !self.has_ipc { return; }
        let Some((side, method)) = self.classify(Some(callee)) else { return };
        let args = args_of(node);
        let resolved = self.resolve_channel(args.first().copied());
        let mut fact = Ipc {
            side, method: method.clone(),
            channel: resolved.as_ref().map(|(v, _)| v.clone()),
            expr: None,
            via: resolved.as_ref().map_or("dynamic", |(_, via)| via),
            line: ln, symbol: ctx.owner.clone(),
        };
        if resolved.is_none() {
            fact.expr = Some(args.first().map_or_else(|| "…".to_string(), |a| truncate(self.t(*a))));
            // Passthrough inside a wrapper: the channel arrives from its call sites.
            if let (Some(owner), Some(params), Some(arg0)) = (&ctx.owner, &ctx.params, args.first().filter(|a| a.kind() == "identifier")) {
                if params.contains(self.t(*arg0)) {
                    fact.via = "param";
                    fact.channel = Some(self.t(*arg0).to_string());
                    if !self.wrappers.has(owner) { self.set_wrapper(owner.clone(), side, method); }
                    self.param_calls.push((self.out.ipc.len(), owner.clone()));
                }
            }
        }
        self.out.ipc.push(fact);
    }

    /// Innermost call whose callee is a known wrapper: (call, spec, wrapper).
    fn wrapper_call_within(&self, value: Node<'a>) -> Option<(Node<'a>, Option<String>, String)> {
        let mut current = Some(value);
        for _ in 0..8 {
            let call = current.filter(|c| c.kind() == "call_expression")?;
            let callee = field(call, "function");
            if let Some(c) = callee.filter(|c| c.kind() == "identifier") {
                let name = self.t(c);
                if self.wrappers.has(name) { return Some((call, None, name.to_string())); }
                if let Some(b) = self.bindings.get(name) { return Some((call, Some(b.spec.clone()), b.imported.clone().unwrap_or_else(|| b.local.clone()))); }
                return None;
            }
            let object = callee.filter(|c| c.kind() == "member_expression").and_then(|c| field(c, "object"));
            current = object.filter(|o| o.kind() == "call_expression");
        }
        None
    }

    /// literal > same-file const table; anything else stays unresolved here.
    fn resolve_channel(&self, arg: Option<Node>) -> Option<(String, &'static str)> {
        if let Some(lit) = self.literal(arg) { return Some((lit, "literal")); }
        let arg = arg?;
        match arg.kind() {
            "identifier" => self.consts.get(self.t(arg)).map(|v| (v.clone(), "const")),
            "member_expression" => self.consts.get(&normalize_member(self.t(arg))).map(|v| (v.clone(), "const")),
            _ => None,
        }
    }

    /// Preload wiring value: literal path, const-table name, or helper call pieces.
    fn preload_fact(&self, value: Option<Node>) -> Option<Preload> {
        let value = value?;
        let ln = line(value);
        let looks_path = |t: &str| t.contains('/') || [".js", ".cjs", ".mjs", ".jsx"].iter().any(|e| t.ends_with(e));
        let preload = |spec: String, literal: bool, external: bool| Preload { spec, line: ln, literal: literal.then_some(true), external_ref: external.then_some(true) };
        if let Some(lit) = self.literal(Some(value)) {
            let clean = js_trim(&lit);
            if !clean.is_empty() { return Some(preload(clean.to_string(), looks_path(clean), false)); }
        }
        if let Some((resolved, _)) = self.resolve_channel(Some(value)) {
            let clean = js_trim(&resolved);
            if !clean.is_empty() { return Some(preload(clean.to_string(), false, false)); }
        }
        if value.kind() == "identifier" || value.kind() == "member_expression" {
            let normalized = normalize_member(self.t(value));
            let normalized = js_trim(&normalized);
            if dotted_ident(normalized) { return Some(preload(normalized.to_string(), false, true)); }
        }
        if value.kind() == "call_expression" {
            let args = args_of(value);
            let mut pieces: Vec<String> = Vec::new();
            for arg in &args {
                let piece = self.literal(Some(*arg)).or_else(|| (arg.kind() == "identifier" || arg.kind() == "member_expression")
                    .then(|| self.resolve_channel(Some(*arg)).map(|(v, _)| v)).flatten());
                if let Some(p) = piece { let p = js_trim(&p); if !p.is_empty() { pieces.push(p.to_string()); } }
            }
            if pieces.is_empty() {
                for arg in args.iter().rev() {
                    if arg.kind() != "identifier" && arg.kind() != "member_expression" { continue; }
                    let normalized = normalize_member(self.t(*arg));
                    let normalized = js_trim(&normalized);
                    if dotted_ident(normalized) { return Some(preload(normalized.to_string(), false, true)); }
                }
                return None;
            }
            if pieces.iter().any(|p| looks_path(p)) {
                let joined = pieces.join("/");
                let mut collapsed = String::with_capacity(joined.len());
                for ch in joined.chars() { if !(ch == '/' && collapsed.ends_with('/')) { collapsed.push(ch); } }
                return Some(preload(collapsed, true, false));
            }
            return Some(preload(pieces.pop().unwrap(), false, false));
        }
        None
    }
}

/// `/^export\s+\*\s*from\b/`
fn export_star(t: &str) -> bool {
    let Some(rest) = t.strip_prefix("export") else { return false };
    if !rest.starts_with(is_js_space) { return false; }
    let Some(rest) = rest.trim_start_matches(is_js_space).strip_prefix('*') else { return false };
    let rest = rest.trim_start_matches(is_js_space);
    rest.strip_prefix("from").is_some_and(|r| !r.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'))
}
