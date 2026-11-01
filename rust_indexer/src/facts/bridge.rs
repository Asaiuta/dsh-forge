//! Lexical bridge scopes: a port of `BridgeScopeIndex` in src/facts.ts.
//!
//! The WASM path resolves each `obj.member` bridge site against the lexical
//! declaration that binds `obj`, and records the declaration's byte span as a
//! stable `binding` key. Trace's `supplementBridgeBindings` re-parses any file
//! whose bridge sites lack that resolution (~25% of a JS corpus, sequentially,
//! through WASM), so producing it here removes a whole second parse.
//!
//! Only the bridge subset of lexical binding is retained: resolved receivers and
//! declaration spans. No tree survives the extraction.

use super::{field, line};
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, TreeCursor};

const FUNCTIONS: &[&str] = &[
    "function_declaration", "generator_function_declaration", "function_expression",
    "function", "generator_function", "arrow_function", "method_definition",
];
const BLOCKS: &[&str] = &[
    "statement_block", "for_statement", "for_in_statement", "catch_clause", "switch_body",
    "class_body",
];
/// Deeper trees already fall back to WASM; the index must not recurse further.
const MAX_DEPTH: usize = 1500;

/// A resolved receiver, shaped for `BridgeReceiver` in src/facts.ts.
#[derive(Clone, Debug, PartialEq)]
pub struct Receiver {
    pub object: String,
    pub via_alias: bool,
    pub uncertain: bool,
    /// A known local value rather than a workspace global.
    pub local: bool,
    /// Written through window/globalThis; a same-named local alias cannot bind it.
    pub qualified: bool,
    pub binding: Option<String>,
}

impl Receiver {
    fn plain(object: String, local: bool, uncertain: bool) -> Self {
        Receiver { object, via_alias: false, uncertain, local, qualified: false, binding: None }
    }
    /// A known local value that resolves to no declaration (a keyword node).
    pub fn plain_local(object: String) -> Self { Self::plain(object, true, false) }
    fn is_bridge(&self) -> bool { self.qualified || self.via_alias }
}

/// `AliasFact` in src/facts.ts, with the declaration identity attached.
pub struct Alias {
    pub name: String,
    pub object: String,
    pub line: u64,
    pub top_level: bool,
    pub binding: String,
    pub reassigned: bool,
    pub uncertain: bool,
}

struct Decl<'t> {
    node: Node<'t>,
    value: Option<Node<'t>>,
    scope: usize,
    binding: String,
    reassigned: bool,
    assigned: Vec<Node<'t>>,
}

struct Scope {
    parent: Option<usize>,
    function: bool,
    declarations: HashMap<String, usize>,
}

pub struct BridgeScopes<'t> {
    src: &'t [u8],
    /// Pure-ASCII source: byte and UTF-16 columns coincide, so span keys skip
    /// the conversion entirely.
    ascii: bool,
    scopes: Vec<Scope>,
    by_node: HashMap<usize, usize>,
    decls: Vec<Decl<'t>>,
}

impl<'t> BridgeScopes<'t> {
    /// Index `root`, then mark the declarations that are written after binding.
    pub fn new(root: Node<'t>, src: &'t [u8]) -> Self {
        let mut scopes = BridgeScopes {
            src,
            ascii: src.is_ascii(),
            scopes: vec![Scope { parent: None, function: true, declarations: HashMap::new() }],
            by_node: HashMap::new(),
            decls: Vec::new(),
        };
        // One cursor for both passes: `node.walk()` allocates, and these walk
        // every node in the file.
        let mut cursor = root.walk();
        scopes.index(root, 0, 0, &mut cursor);
        scopes.writes(root, 0, &mut cursor);
        scopes
    }

    fn t(&self, node: Node) -> &'t str {
        node.utf8_text(self.src).unwrap_or("")
    }

    /// Whether columns are bytes (pure ASCII) or need UTF-16 conversion.
    pub fn ascii(&self) -> bool { self.ascii }

    fn text_of(&self, node: Node) -> String { self.t(node).to_string() }

    /// `propertyName`: the static property of a member access.
    fn property_name(&self, node: Node) -> Option<String> {
        let prop = field(node, "property")?;
        matches!(prop.kind(), "property_identifier" | "identifier" | "private_property_identifier")
            .then(|| self.text_of(prop))
    }

    /// `spanKey(spanOf(node))` — the identity a resolved alias is matched by.
    fn span_key(&self, node: Node) -> String {
        let span = super::span_of(node, self.src, self.ascii);
        format!("{}:{}-{}:{}", span.start.line, span.start.column, span.end.line, span.end.column)
    }

    fn add(&mut self, scope: usize, name: Node, node: Node<'t>, value: Option<Node<'t>>) {
        let key = self.text_of(name);
        if let Some(&existing) = self.scopes[scope].declarations.get(&key) {
            self.decls[existing].reassigned = true;
            return;
        }
        let binding = self.span_key(name);
        self.decls.push(Decl { node, value, scope, binding, reassigned: false, assigned: Vec::new() });
        self.scopes[scope].declarations.insert(key, self.decls.len() - 1);
    }

    /// Binding patterns: `this.names` in src/facts.ts.
    fn names(&self, pattern: Node<'t>) -> Vec<Node<'t>> {
        match pattern.kind() {
            "identifier" | "shorthand_property_identifier_pattern" => vec![pattern],
            "pair_pattern" => field(pattern, "value").map(|value| self.names(value)).unwrap_or_default(),
            "assignment_pattern" | "object_assignment_pattern" => {
                field(pattern, "left").map(|left| self.names(left)).unwrap_or_default()
            }
            "required_parameter" | "optional_parameter" => {
                field(pattern, "pattern").or_else(|| field(pattern, "name"))
                    .map(|value| self.names(value)).unwrap_or_default()
            }
            "object_pattern" | "array_pattern" | "rest_pattern" | "formal_parameters" => {
                self.kids(pattern).into_iter().flat_map(|child| self.names(child)).collect()
            }
            _ => Vec::new(),
        }
    }

    /// `node.children` on the fact view: named children, none below a leaf.
    fn kids(&self, node: Node<'t>) -> Vec<Node<'t>> {
        let mut cursor = node.walk();
        node.named_children(&mut cursor).collect()
    }

    /// `kids` on a reused cursor: the file-wide passes must not allocate one
    /// per node.
    fn kids_with(node: Node<'t>, cursor: &mut TreeCursor<'t>) -> Vec<Node<'t>> {
        cursor.reset(node);
        node.named_children(cursor).collect()
    }

    fn index(&mut self, node: Node<'t>, parent: usize, depth: usize, cursor: &mut TreeCursor<'t>) {
        if depth > MAX_DEPTH { return; }
        let kind = node.kind();
        let function = FUNCTIONS.contains(&kind);
        let name = field(node, "name");
        if matches!(kind, "function_declaration" | "generator_function_declaration" | "class_declaration") {
            if let Some(name) = name.filter(|n| n.kind() == "identifier") { self.add(parent, name, node, None); }
        }
        let mut scope = parent;
        if function || BLOCKS.contains(&kind) {
            self.scopes.push(Scope { parent: Some(parent), function, declarations: HashMap::new() });
            scope = self.scopes.len() - 1;
        }
        self.by_node.insert(node.id(), scope);
        if function {
            if let Some(params) = field(node, "parameters").or_else(|| field(node, "parameter")) {
                for param in self.names(params) { self.add(scope, param, param, None); }
            }
            if let Some(name) = name.filter(|n| n.kind() == "identifier") {
                if matches!(kind, "function_expression" | "function" | "generator_function") {
                    self.add(scope, name, node, None);
                }
            }
        }
        if kind == "catch_clause" {
            if let Some(param) = field(node, "parameter") {
                for bound in self.names(param) { self.add(scope, bound, param, None); }
            }
        }
        if kind == "variable_declarator" {
            let pattern = field(node, "name");
            let value = field(node, "value");
            // `var`/`let`/`const` bind in the nearest function scope, not the
            // block that holds the statement.
            let mut owner = scope;
            if node.parent().is_some_and(|parent| parent.kind() == "variable_declaration") {
                while !self.scopes[owner].function {
                    match self.scopes[owner].parent {
                        Some(parent) => owner = parent,
                        None => break,
                    }
                }
            }
            if let Some(pattern) = pattern {
                let bound = pattern.kind() == "identifier";
                for name in self.names(pattern) { self.add(owner, name, node, if bound { value } else { None }); }
            }
        }
        if kind == "import_specifier" {
            if let Some(local) = field(node, "alias").or_else(|| field(node, "name")) {
                if local.kind() == "identifier" { self.add(scope, local, node, None); }
            }
        } else if kind == "identifier"
            && node.parent().is_some_and(|p| matches!(p.kind(), "import_clause" | "namespace_import"))
        {
            self.add(scope, node, node, None);
        }
        for child in Self::kids_with(node, cursor) { self.index(child, scope, depth + 1, cursor); }
    }

    /// `this.writes`: a later assignment invalidates an initializer as an alias.
    fn writes(&mut self, node: Node<'t>, depth: usize, cursor: &mut TreeCursor<'t>) {
        if depth > MAX_DEPTH { return; }
        let target = match node.kind() {
            "assignment_expression" | "augmented_assignment_expression" => field(node, "left"),
            "update_expression" => field(node, "argument"),
            _ => None,
        };
        if let Some(target) = target {
            for name in self.names(target) {
                let text = self.text_of(name);
                if let Some(declaration) = self.declaration(node, &text) {
                    self.decls[declaration].reassigned = true;
                    if let Some(value) = field(node, "right") { self.decls[declaration].assigned.push(value); }
                }
            }
        }
        for child in Self::kids_with(node, cursor) { self.writes(child, depth + 1, cursor); }
    }

    fn declaration(&self, node: Node, name: &str) -> Option<usize> {
        let mut scope = *self.by_node.get(&node.id())?;
        loop {
            if let Some(&found) = self.scopes[scope].declarations.get(name) { return Some(found); }
            scope = self.scopes[scope].parent?;
        }
    }

    pub fn receiver(&self, node: Node<'t>) -> Receiver { self.resolve(node, &HashSet::new()) }

    fn resolve(&self, node: Node<'t>, visited: &HashSet<usize>) -> Receiver {
        let kind = node.kind();
        // Creating a value does not give it the identity of a reference in its
        // fields or body; the ordinary walker records those inner uses itself.
        if FUNCTIONS.contains(&kind) || matches!(kind, "object" | "array" | "class") {
            return Receiver::plain(self.text_of(node), true, false);
        }
        if kind == "parenthesized_expression" {
            if let Some(inner) = self.kids(node).into_iter().next() { return self.resolve(inner, visited); }
        }
        if kind == "member_expression" {
            if let Some(base) = field(node, "object") {
                if base.kind() == "identifier" && matches!(self.t(base), "window" | "globalThis") {
                    if let Some(member) = self.property_name(node) {
                        let shadowed = self.declaration(base, self.t(base)).is_some();
                        return Receiver { qualified: true, ..Receiver::plain(member, false, shadowed) };
                    }
                }
            }
        }
        if kind == "identifier" {
            let text = self.text_of(node);
            let Some(declaration) = self.declaration(node, &text) else {
                return Receiver::plain(text, false, false);
            };
            if visited.contains(&declaration) { return Receiver::plain(text, true, false); }
            let decl = &self.decls[declaration];
            if visited.len() >= 8 {
                return Receiver { via_alias: true, binding: Some(decl.binding.clone()),
                    ..Receiver::plain(text, false, true) };
            }
            let mut seen = visited.clone();
            seen.insert(declaration);
            let mut value = match decl.value {
                Some(value) => self.resolve(value, &seen),
                None => Receiver::plain(text.clone(), true, false),
            };
            // Parameters and ordinary locals shadow bridge names with certainty.
            // A write that actually mentions a bridge keeps that origin visible.
            if !value.qualified && !value.via_alias {
                for assigned in self.decls[declaration].assigned.clone() {
                    let candidate = self.resolve(assigned, &seen);
                    if candidate.is_bridge() {
                        value = Receiver { uncertain: true, ..candidate };
                        break;
                    }
                }
            }
            let bridge = value.is_bridge();
            let binding = self.decls[declaration].binding.clone();
            let reassigned = self.decls[declaration].reassigned;
            Receiver {
                object: if bridge { value.object } else { text },
                via_alias: bridge,
                uncertain: bridge && (value.uncertain || reassigned),
                local: !bridge,
                qualified: false,
                binding: Some(binding),
            }
        } else {
            // Conditional/fallback/call expressions can mention a bridge while
            // returning something else: keep the evidence, never pick a branch.
            for child in self.kids(node) {
                let candidate = self.resolve(child, visited);
                if candidate.is_bridge() {
                    return Receiver { uncertain: true, via_alias: true, qualified: false, ..candidate };
                }
            }
            Receiver::plain(self.text_of(node), true, false)
        }
    }

    /// `this.alias`: a declaration whose initializer resolves to a bridge root.
    pub fn alias(&self, name: &str, value: Node<'t>) -> Option<Alias> {
        let declaration = self.declaration(value, name)?;
        let decl = &self.decls[declaration];
        let identifier = field(decl.node, "name");
        let resolved = match identifier {
            Some(identifier) if identifier.kind() == "identifier" => self.resolve(identifier, &HashSet::new()),
            _ => {
                let mut seen = HashSet::new();
                seen.insert(declaration);
                match decl.value {
                    Some(inner) => self.resolve(inner, &seen),
                    None => self.resolve(value, &seen),
                }
            }
        };
        if !resolved.is_bridge() { return None; }
        Some(Alias {
            name: name.to_string(),
            object: resolved.object,
            line: line(decl.node),
            top_level: self.scopes[decl.scope].parent.is_none(),
            binding: decl.binding.clone(),
            reassigned: decl.reassigned,
            uncertain: resolved.uncertain,
        })
    }
}
