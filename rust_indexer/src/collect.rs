//! Clean-room symbol collector for all eleven dsh-forge languages. This is a
//! faithful Rust port of the `Collector` traversal in src/ast.ts (MIT); no
//! ProjectForge (CC-BY-NC-SA) code is copied — tree-sitter only supplies the
//! parse tree, and every symbol is derived from that tree exactly as ast.ts
//! derives it.
//!
//! Node-API equivalence relied upon here:
//!   node.type              -> node.kind()
//!   node.children          -> child_count() / child(i)   (named AND anonymous)
//!   node.isNamed           -> is_named()
//!   node.childForFieldName -> child_by_field_name
//!   node.text              -> &src[start_byte()..end_byte()]
//!   node.startIndex/end    -> start_byte()/end_byte()
//!   node.startPosition.row -> start_position().row  (0-based -> +1 exported)
//!   node.id                -> node.id()             (sibling identity)

use crate::symbol::Symbol;
use tree_sitter::Node;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Module,
    Class,
    Function,
}

/// Per-language declaration table, mirroring `FamilySpec` in ast.ts.
struct Family {
    /// (node kind -> symbol kind)
    declarations: &'static [(&'static str, &'static str)],
    /// Node types whose children are searched transparently.
    wrappers: &'static [&'static str],
    /// Comment node types for adjacent-comment capture.
    comments: &'static [&'static str],
    /// Field holding the declaration name (default `name`).
    name_field: &'static str,
}

const C_LIKE: Family = Family {
    declarations: &[
        ("class_declaration", "class"),
        ("class", "class"),
        ("abstract_class_declaration", "class"),
        ("abstract_class", "class"),
        ("function_declaration", "function"),
        ("generator_function_declaration", "function"),
        ("method_definition", "method"),
        ("interface_declaration", "interface"),
        ("enum_declaration", "enum"),
        ("type_alias_declaration", "type"),
        ("method_signature", "method"),
        ("property_signature", "field"),
        ("public_field_definition", "field"),
        ("field_definition", "field"),
    ],
    wrappers: &["export_statement", "export_clause", "decorated_definition", "ambient_declaration", "declaration"],
    comments: &["comment"],
    name_field: "name",
};

const PY: Family = Family {
    declarations: &[("function_definition", "function"), ("class_definition", "class")],
    wrappers: &["decorated_definition", "block"],
    comments: &["comment"],
    name_field: "name",
};

const RS: Family = Family {
    declarations: &[
        ("function_item", "function"),
        // Bodyless trait method declarations (`fn name(&self) -> &str;`) are a
        // distinct node. Without this the entire required-interface surface of
        // every Rust trait is invisible.
        ("function_signature_item", "function"),
        ("struct_item", "struct"),
        ("enum_item", "enum"),
        ("trait_item", "trait"),
        ("type_item", "type"),
        ("mod_item", "module"),
        ("foreign_mod_item", "module"),
        ("const_item", "variable"),
        ("static_item", "variable"),
        ("field_declaration", "field"),
        ("enum_variant", "field"),
    ],
    wrappers: &["declaration_list", "declaration", "mod_contents"],
    comments: &["line_comment", "block_comment"],
    name_field: "name",
};

const GO: Family = Family {
    declarations: &[
        ("function_declaration", "function"),
        ("method_declaration", "method"),
        ("field_declaration", "field"),
        // `method_spec` is the name in the WASM grammar (tree-sitter-go 0.20);
        // 0.21+ renamed it to `method_elem`. Both map to the same symbol.
        ("method_spec", "method"),
        ("method_elem", "method"),
        ("var_spec", "variable"),
        ("const_spec", "variable"),
    ],
    wrappers: &[],
    comments: &["comment"],
    name_field: "name",
};

const NATIVE_C: Family = Family {
    declarations: &[
        ("function_definition", "function"),
        ("struct_specifier", "struct"),
        ("union_specifier", "struct"),
        ("enum_specifier", "enum"),
        ("class_specifier", "class"),
        ("namespace_definition", "module"),
        ("alias_declaration", "type"),
        ("enumerator", "field"),
    ],
    wrappers: &["template_declaration", "linkage_specification", "declaration_list"],
    comments: &["comment"],
    name_field: "name",
};

const JAVA: Family = Family {
    declarations: &[
        ("class_declaration", "class"),
        ("interface_declaration", "interface"),
        ("enum_declaration", "enum"),
        ("record_declaration", "struct"),
        ("method_declaration", "method"),
        ("constructor_declaration", "method"),
        ("enum_constant", "field"),
        ("annotation_type_declaration", "interface"),
    ],
    wrappers: &[],
    comments: &["line_comment", "block_comment"],
    name_field: "name",
};

const CSHARP: Family = Family {
    declarations: &[
        ("namespace_declaration", "module"),
        ("file_scoped_namespace_declaration", "module"),
        ("class_declaration", "class"),
        ("struct_declaration", "struct"),
        ("record_declaration", "struct"),
        ("interface_declaration", "interface"),
        ("enum_declaration", "enum"),
        ("method_declaration", "method"),
        ("constructor_declaration", "method"),
        ("property_declaration", "field"),
        ("enum_member_declaration", "field"),
        ("delegate_declaration", "type"),
    ],
    wrappers: &[],
    comments: &["comment"],
    name_field: "name",
};

const LUA: Family = Family {
    declarations: &[
        // WASM grammar (Azganoth/tree-sitter-lua 2.x) names.
        ("function_definition_statement", "function"),
        ("local_function_definition_statement", "function"),
        // crates.io tree-sitter-lua 0.5 grammar name for the same construct;
        // local-ness is a parent field there, not a distinct node type.
        ("function_declaration", "function"),
    ],
    wrappers: &[],
    comments: &["comment"],
    name_field: "name",
};

fn family_for(lang: &str) -> &'static Family {
    match lang {
        "python" => &PY,
        "rust" => &RS,
        "go" => &GO,
        "c" | "cpp" => &NATIVE_C,
        "java" => &JAVA,
        "c_sharp" => &CSHARP,
        "lua" => &LUA,
        _ => &C_LIKE,
    }
}

fn declaration_kind(spec: &Family, kind: &str) -> Option<&'static str> {
    spec.declarations.iter().find(|(k, _)| *k == kind).map(|(_, v)| *v)
}

fn is_wrapper(spec: &Family, kind: &str) -> bool {
    spec.wrappers.contains(&kind)
}

fn is_comment(spec: &Family, kind: &str) -> bool {
    spec.comments.contains(&kind)
}

fn is_container_kind(kind: &str) -> bool {
    matches!(kind, "class" | "interface" | "trait" | "struct" | "enum" | "object")
}
fn is_callable_kind(kind: &str) -> bool {
    matches!(kind, "function" | "method")
}

fn is_js(lang: &str) -> bool {
    matches!(lang, "javascript" | "typescript" | "tsx")
}
fn is_c_family(lang: &str) -> bool {
    matches!(lang, "c" | "cpp")
}
fn is_java_family(lang: &str) -> bool {
    matches!(lang, "java" | "c_sharp")
}

/// All children (named AND anonymous), matching `node.children` in ast.ts.
fn children(node: Node) -> Vec<Node> {
    (0..node.child_count()).filter_map(|i| node.child(i)).collect()
}

/// `table` (WASM grammar, Azganoth 2.x) and `table_constructor` (crates.io
/// tree-sitter-lua 0.5) are the same Lua construct across grammar generations.
fn is_lua_table(kind: &str) -> bool {
    matches!(kind, "table" | "table_constructor")
}

/// Find a descendant up to two levels down. The crates.io Lua grammar nests
/// `variable_list`/`expression_list` inside an `assignment_statement`, whereas
/// the WASM grammar keeps them as direct children of the declaration.
fn find_descendant2<'t>(node: Node<'t>, kind: &str) -> Option<Node<'t>> {
    if let Some(c) = children(node).into_iter().find(|c| c.kind() == kind) {
        return Some(c);
    }
    for child in children(node) {
        if !child.is_named() {
            continue;
        }
        if let Some(g) = children(child).into_iter().find(|g| g.kind() == kind) {
            return Some(g);
        }
    }
    None
}

/// `nameOf`: the name-field child's text.
fn name_of(node: Node, spec: &Family, src: &str) -> Option<String> {
    node.child_by_field_name(spec.name_field).map(|n| text_of(n, src))
}

fn text_of(node: Node, src: &str) -> String {
    src[node.start_byte()..node.end_byte()].to_string()
}

/// Go receiver type: `func (s *Store) Put()` -> `Store`.
fn go_receiver_name(node: Node, src: &str) -> Option<String> {
    let receiver = node.child_by_field_name("receiver")?;
    let parameter = children(receiver).into_iter().find(|n| n.kind() == "parameter_declaration")?;
    let ty = parameter.child_by_field_name("type")?;
    let raw = text_of(ty, src);
    let trimmed = raw.strip_prefix('*').unwrap_or(&raw);
    // `.replace(/\[.*\]$/, '')` — greedy, so a trailing `[A][B]` is dropped whole.
    match trimmed.find('[') {
        Some(idx) if trimmed.ends_with(']') => Some(trimmed[..idx].to_string()),
        _ => Some(trimmed.to_string()),
    }
}

/// Declaration wrappers and Rust attributes travel with the declaration.
fn declaration_start(node: Node, parent: Option<Node>, lang: &str) -> usize {
    let mut start = node.start_byte();
    let mut cursor = node;
    let mut owner = parent;
    while let Some(o) = owner {
        if matches!(o.kind(), "decorated_definition" | "export_statement" | "template_declaration") {
            start = o.start_byte();
            cursor = o;
            owner = o.parent();
        } else {
            break;
        }
    }
    if lang == "rust" {
        // Walk preceding siblings directly. Materializing the sibling list here
        // is O(siblings) per declaration — quadratic on generated files with tens
        // of thousands of items, which dominated cold parses of the Rust corpus.
        let mut prev = cursor.prev_sibling();
        while let Some(previous) = prev {
            if previous.kind() == "attribute_item" {
                start = previous.start_byte();
            } else if !matches!(previous.kind(), "line_comment" | "block_comment") {
                break;
            }
            prev = previous.prev_sibling();
        }
    }
    start
}

/// `impl<T> Foo<T>` / `impl Trait for Foo<T>` qualify their members by the bare
/// type name, so the generic argument list must not leak into the prefix
/// (`AudioBlockRef::new`, not `AudioBlockRef<'a>::new`). Mirrors ProjectForge's
/// `raw.split('<').next().trim()` normalization.
fn rust_base_type(raw: &str) -> String {
    raw.split('<').next().unwrap_or("").trim().to_string()
}

fn is_list_member(node: Node, parent: Option<Node>, lang: &str) -> bool {
    matches!(node.kind(), "pair" | "enum_variant" | "enumerator" | "enum_constant" | "enum_member_declaration")
        || (lang == "lua" && node.kind() == "field")
        || (node.kind() == "method_definition" && parent.map(|p| p.kind() == "object").unwrap_or(false))
}

/// Comment run immediately above `node`, climbing through wrappers.
fn comment_start_row(parent: Option<Node>, node: Node, spec: &Family) -> Option<(u32, u32)> {
    let mut cursor = node;
    let mut cursor_parent = parent;
    for _ in 0..3 {
        let Some(cp) = cursor_parent else { break };
        // Step back through siblings directly. Building `children(cp)` for every
        // symbol is O(siblings) each time — quadratic on files with very many
        // items, and the dominant cost of cold Rust-corpus parses.
        let mut first: Option<Node> = None;
        let mut next_row = cursor.start_position().row as i64;
        let mut prev = cursor.prev_sibling();
        while let Some(p) = prev {
            if (p.end_position().row as i64) < next_row - 1 {
                break;
            }
            if is_comment(spec, p.kind()) {
                first = Some(p);
                next_row = p.start_position().row as i64;
            } else if matches!(p.kind(), "decorator" | "attribute_item" | "decorator_definition") {
                next_row = p.start_position().row as i64;
            } else {
                break;
            }
            prev = p.prev_sibling();
        }
        if let Some(f) = first {
            return Some((f.start_position().row as u32 + 1, f.start_byte() as u32));
        }
        if !is_wrapper(spec, cp.kind()) {
            break;
        }
        cursor = cp;
        cursor_parent = cp.parent();
    }
    None
}

/// Maps tree-sitter's UTF-8 **byte** offsets onto the **UTF-16 code-unit**
/// offsets web-tree-sitter reports as `startIndex`/`endIndex`. The two agree
/// for ASCII but diverge on any non-ASCII character, and `AstSymbol` offsets
/// are used with JS `.slice()`, so they must be code units to stay correct.
///
/// Checkpoints are recorded after every non-ASCII character (which is the only
/// place the two differ); between checkpoints the mapping is 1:1, so a lookup
/// is a binary search. ASCII-only files store no checkpoints and skip the work.
pub struct Utf16Map {
    checkpoints: Vec<(u32, u32)>,
}

impl Utf16Map {
    pub fn new(text: &str) -> Self {
        let mut checkpoints = Vec::new();
        let mut byte = 0u32;
        let mut utf16 = 0u32;
        for ch in text.chars() {
            byte += ch.len_utf8() as u32;
            utf16 += ch.len_utf16() as u32;
            if ch.len_utf8() != ch.len_utf16() {
                checkpoints.push((byte, utf16));
            }
        }
        Self { checkpoints }
    }

    pub fn to_utf16(&self, byte: usize) -> u32 {
        let target = byte as u32;
        if self.checkpoints.is_empty() {
            return target;
        }
        match self.checkpoints.binary_search_by(|&(b, _)| b.cmp(&target)) {
            Ok(i) => self.checkpoints[i].1,
            Err(0) => target,
            Err(i) => {
                let (b, u) = self.checkpoints[i - 1];
                u + (target - b)
            }
        }
    }
}

pub struct Collector<'a> {
    pub out: Vec<Symbol>,
    spec: &'static Family,
    lang: &'static str,
    sep: &'static str,
    src: &'a str,
    map: &'a Utf16Map,
}

impl<'a> Collector<'a> {
    /// Debug helper: dump the parse tree as an s-expression so grammar node
    /// names can be compared against the WASM grammar's expectations.
    pub fn sexp(src: &str, lang: &'static str) -> Option<String> {
        let mut parser = parser_for(lang)?;
        let tree = parser.parse(src, None)?;
        Some(tree.root_node().to_sexp())
    }

    /// Extract symbols and the parse-error flag (mirrors `partial = rootNode.hasError`).
    pub fn extract(src: &'a str, lang: &'static str) -> (Vec<Symbol>, bool) {
        let map = Utf16Map::new(src);
        let mut c = Collector {
            out: Vec::new(),
            spec: family_for(lang),
            lang,
            sep: if lang == "rust" { "::" } else { "." },
            src,
            map: &map,
        };
        let Some(mut parser) = parser_for(lang) else {
            return (c.out, false);
        };
        let mut has_error = false;
        if let Some(tree) = parser.parse(src, None) {
            has_error = tree.root_node().has_error();
            c.collect(tree.root_node(), None, None, Scope::Module);
        }
        (c.out, has_error)
    }

    /// Emit a symbol and return its slot in `out` (so callers can attach
    /// children after the immutable `children_of` borrow ends).
    fn emit(
        &mut self,
        node: Node,
        simple: String,
        kind: &str,
        prefix: Option<&str>,
        parent: Option<Node>,
    ) -> usize {
        let qualified = match prefix {
            Some(p) => format!("{}{}{}", p, self.sep, simple),
            None => simple.clone(),
        };
        let mut symbol = Symbol {
            name: simple,
            qualified_name: qualified,
            kind: kind.to_string(),
            start_offset: self.u16(declaration_start(node, parent, self.lang)),
            end_offset: self.u16(node.end_byte()),
            start_line: node.start_position().row as u32 + 1,
            end_line: node.end_position().row as u32 + 1,
            children: Vec::new(),
            comment_start_line: None,
            comment_start_offset: None,
            shared_declaration: None,
            list_member: None,
        };
        if is_list_member(node, parent, self.lang) {
            symbol.list_member = Some(true);
        }
        if let Some((line, offset)) = comment_start_row(parent, node, self.spec) {
            if line < symbol.start_line {
                symbol.comment_start_line = Some(line);
                symbol.comment_start_offset = Some(self.u16(offset as usize));
            }
        }
        self.out.push(symbol);
        self.out.len() - 1
    }

    /// Run a fresh collector over `node`'s children, qualified by `prefix`.
    fn children_of(&self, node: Node, prefix: &str, scope: Scope) -> Vec<Symbol> {
        self.children_of_opt(node, Some(prefix), scope)
    }

    /// As `children_of`, but keeps a null prefix null (Rust impl without a
    /// target type, matching ast.ts's `implPrefix` which can be null).
    fn children_of_opt(&self, node: Node, prefix: Option<&str>, scope: Scope) -> Vec<Symbol> {
        let mut inner = Collector {
            out: Vec::new(),
            spec: self.spec,
            lang: self.lang,
            sep: self.sep,
            src: self.src,
            map: self.map,
        };
        // Index-based walk: materializing a Vec per node is a large allocation
        // cost on the hottest path (every node of every file).
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                inner.collect(child, prefix, Some(node), scope);
            }
        }
        inner.out
    }

    /// Byte offset -> UTF-16 code-unit offset (what web-tree-sitter reports).
    fn u16(&self, byte: usize) -> u32 {
        self.map.to_utf16(byte)
    }

    pub fn collect(&mut self, node: Node, prefix: Option<&str>, parent: Option<Node>, scope: Scope) {
        let k = node.kind();

        // --- C / C++ declarator handling ------------------------------------
        if is_c_family(self.lang) && matches!(k, "declaration" | "field_declaration" | "type_definition") {
            if scope == Scope::Function {
                return;
            }
            const DECLARATOR_KINDS: [&str; 7] = [
                "identifier", "field_identifier", "type_identifier", "init_declarator",
                "function_declarator", "pointer_declarator", "array_declarator",
            ];
            let kids = children(node);
            let declarators: Vec<Node> = kids.iter().copied().filter(|c| DECLARATOR_KINDS.contains(&c.kind())).collect();
            let has_specifier_body = kids
                .iter()
                .any(|c| c.kind().ends_with("_specifier") && c.child_by_field_name("body").is_some());
            for child in &kids {
                if child.kind().ends_with("_specifier") && child.child_by_field_name("body").is_some() {
                    self.collect(*child, prefix, Some(node), scope);
                }
                if !DECLARATOR_KINDS.contains(&child.kind()) {
                    continue;
                }
                let mut target = *child;
                let mut callable = false;
                while let Some(d) = target.child_by_field_name("declarator") {
                    if target.kind() == "function_declarator" {
                        callable = true;
                    }
                    target = d;
                }
                let name = text_of(target, self.src);
                let kind = if node.kind() == "type_definition" {
                    "type"
                } else if callable {
                    if scope == Scope::Class { "method" } else { "function" }
                } else if scope == Scope::Class {
                    "field"
                } else {
                    "variable"
                };
                let slot = self.emit(node, name, kind, prefix, parent);
                if declarators.len() > 1 || has_specifier_body {
                    self.out[slot].shared_declaration = Some(true);
                }
            }
            return;
        }
        if is_c_family(self.lang) && k.ends_with("_specifier") && node.child_by_field_name("body").is_none() {
            return;
        }

        // --- Java / C# field declarations (one symbol per declarator) -------
        if is_java_family(self.lang) && k == "field_declaration" {
            let mut emitted: Vec<usize> = Vec::new();
            let mut stack: Vec<Node> = children(node);
            stack.reverse();
            while let Some(child) = stack.pop() {
                if child.kind() == "variable_declarator" {
                    let name = child
                        .child_by_field_name("name")
                        .or_else(|| children(child).into_iter().find(|c| c.kind() == "identifier"));
                    if let Some(name) = name {
                        let slot = self.out.len();
                        self.emit(node, text_of(name, self.src), "field", prefix, parent);
                        emitted.push(slot);
                    }
                } else {
                    let mut nested = children(child);
                    nested.reverse();
                    stack.extend(nested);
                }
            }
            if emitted.len() > 1 {
                for slot in emitted {
                    self.out[slot].shared_declaration = Some(true);
                }
            }
            return;
        }

        // --- Python module/class assignments --------------------------------
        if self.lang == "python" && k == "assignment" {
            let target = node.child_by_field_name("left");
            if scope != Scope::Function {
                if let Some(t) = target {
                    if t.kind() == "identifier" {
                        let kind = if scope == Scope::Class { "field" } else { "variable" };
                        self.emit(node, text_of(t, self.src), kind, prefix, parent);
                    }
                }
            }
            return;
        }

        // --- Lua variable declarations --------------------------------------
        if self.lang == "lua"
            && matches!(
                k,
                "local_variable_declaration" | "variable_assignment" | "variable_declaration" | "assignment_statement"
            )
        {
            if scope == Scope::Function {
                return;
            }
            let targets: Vec<Node> = find_descendant2(node, "variable_list")
                .map(|vl| children(vl).into_iter().filter(|c| c.is_named()).collect())
                .unwrap_or_default();
            let values: Vec<Node> = find_descendant2(node, "expression_list")
                .map(|el| children(el).into_iter().filter(|c| c.is_named()).collect())
                .unwrap_or_default();
            for (index, target) in targets.iter().enumerate() {
                let value = values.get(index).copied();
                let name = text_of(*target, self.src).replace(':', ".");
                let kind = match value.map(|v| v.kind()) {
                    Some(k) if is_lua_table(k) => "object",
                    Some("function_definition") => "function",
                    _ => "variable",
                };
                let mut children_out = Vec::new();
                if let Some(v) = value {
                    let vscope = if is_lua_table(v.kind()) { Scope::Class } else { Scope::Function };
                    let qualified = match prefix {
                        Some(p) => format!("{}{}{}", p, self.sep, name),
                        None => name.clone(),
                    };
                    children_out = self.children_of(v, &qualified, vscope);
                }
                let slot = self.emit(node, name, kind, prefix, parent);
                if targets.len() > 1 {
                    self.out[slot].shared_declaration = Some(true);
                }
                self.out[slot].children = children_out;
            }
            return;
        }
        if self.lang == "lua" && k == "field" {
            // WASM grammar: `key`/`value`. crates.io grammar: `name`/`value`.
            let key = node
                .child_by_field_name("key")
                .or_else(|| node.child_by_field_name("name"));
            let value = node.child_by_field_name("value");
            if let Some(key) = key {
                if key.kind() == "identifier" {
                    let kind = match value.map(|v| v.kind()) {
                        Some("function_definition") => "method",
                        Some(k) if is_lua_table(k) => "object",
                        _ => "field",
                    };
                    let qualified = match prefix {
                        Some(p) => format!("{}{}{}", p, self.sep, text_of(key, self.src)),
                        None => text_of(key, self.src),
                    };
                    let mut children_out = Vec::new();
                    if let Some(v) = value {
                        let vscope = if is_lua_table(v.kind()) { Scope::Class } else { Scope::Function };
                        children_out = self.children_of(v, &qualified, vscope);
                    }
                    let slot = self.emit(node, text_of(key, self.src), kind, prefix, parent);
                    self.out[slot].children = children_out;
                }
            }
            return;
        }

        // --- Go type declarations -------------------------------------------
        if self.lang == "go" && k == "type_spec" {
            if let Some(name) = name_of(node, self.spec, self.src) {
                let kinds: Vec<&str> = children(node).iter().map(|c| c.kind()).collect();
                let kind = if kinds.contains(&"struct_type") {
                    "struct"
                } else if kinds.contains(&"interface_type") {
                    "interface"
                } else {
                    "type"
                };
                let qualified = match prefix {
                    Some(p) => format!("{}{}{}", p, self.sep, name),
                    None => name.clone(),
                };
                let mut sym = Symbol {
                    start_offset: self.u16(node.start_byte()),
                    end_offset: self.u16(node.end_byte()),
                    name,
                    qualified_name: qualified.clone(),
                    kind: kind.to_string(),
                    start_line: node.start_position().row as u32 + 1,
                    end_line: node.end_position().row as u32 + 1,
                    children: Vec::new(),
                    comment_start_line: None,
                    comment_start_offset: None,
                    shared_declaration: None,
                    list_member: None,
                };
                if is_list_member(node, parent, self.lang) {
                    sym.list_member = Some(true);
                }
                if let Some((line, offset)) = comment_start_row(parent, node, self.spec) {
                    if line < sym.start_line {
                        sym.comment_start_line = Some(line);
                        sym.comment_start_offset = Some(self.u16(offset as usize));
                    }
                }
                self.out.push(sym);
                let inner = self.children_of(node, &qualified, Scope::Class);
                self.out.last_mut().unwrap().children = inner;
            }
            return;
        }

        // --- Rust impl blocks ------------------------------------------------
        if self.lang == "rust" && k == "impl_item" {
            let target_type = node.child_by_field_name("type");
            let base = target_type.map(|t| rust_base_type(&text_of(t, self.src)));
            let impl_prefix = match &base {
                Some(ty) => Some(match prefix {
                    Some(p) => format!("{}{}{}", p, self.sep, ty),
                    None => ty.clone(),
                }),
                None => prefix.map(|p| p.to_string()),
            };
            let label = format!("impl {}", base.unwrap_or_else(|| "?".to_string()));
            let inner = self.children_of_opt(node, impl_prefix.as_deref(), Scope::Class);
            let slot = self.emit(node, label, "impl", prefix, parent);
            self.out[slot].children = inner;
            return;
        }

        // --- Wrappers: search children transparently --------------------------
        if is_wrapper(self.spec, k) {
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    self.collect(child, prefix, Some(node), scope);
                }
            }
            return;
        }

        // --- Mapped declarations ---------------------------------------------
        if let Some(base_kind) = declaration_kind(self.spec, k) {
            let mut simple = name_of(node, self.spec, self.src);
            if k == "function_definition" && is_c_family(self.lang) {
                let mut declarator = node.child_by_field_name("declarator");
                while let Some(d) = declarator.and_then(|d| d.child_by_field_name("declarator")) {
                    declarator = Some(d);
                }
                simple = declarator.map(|d| text_of(d, self.src).replace("::", "."));
            }
            if self.lang == "lua" {
                simple = simple.map(|s| s.replace(':', "."));
            }
            let effective_kind: &str = if self.lang == "python" && k == "function_definition" && scope == Scope::Class {
                "method"
            } else if is_c_family(self.lang) && base_kind == "function" && scope == Scope::Class {
                "method"
            } else if self.lang == "lua" && simple.as_deref().map(|s| s.contains('.')).unwrap_or(false) && base_kind == "function" {
                "method"
            } else {
                base_kind
            };
            if effective_kind == "variable" && scope == Scope::Function {
                return;
            }
            if k == "method_declaration" && self.lang == "go" {
                if let Some(receiver) = go_receiver_name(node, self.src) {
                    simple = Some(format!("{}.{}", receiver, simple.unwrap_or_default()));
                }
            }
            if let Some(simple) = simple {
                let qualified = match prefix {
                    Some(p) => format!("{}{}{}", p, self.sep, simple),
                    None => simple.clone(),
                };
                let start_line = if parent.map(|p| p.kind() == "decorated_definition").unwrap_or(false) {
                    parent.unwrap().start_position().row as u32 + 1
                } else {
                    node.start_position().row as u32 + 1
                };
                let mut sym = Symbol {
                    start_offset: self.u16(declaration_start(node, parent, self.lang)),
                    end_offset: self.u16(node.end_byte()),
                    name: simple,
                    qualified_name: qualified.clone(),
                    kind: effective_kind.to_string(),
                    start_line,
                    end_line: node.end_position().row as u32 + 1,
                    children: Vec::new(),
                    comment_start_line: None,
                    comment_start_offset: None,
                    shared_declaration: None,
                    list_member: None,
                };
                if is_c_family(self.lang) {
                    if let Some(p) = parent {
                        const DECLARATOR_KINDS: [&str; 7] = [
                            "identifier", "field_identifier", "type_identifier", "init_declarator",
                            "function_declarator", "pointer_declarator", "array_declarator",
                        ];
                        let pk = p.kind();
                        if matches!(pk, "declaration" | "field_declaration" | "type_definition")
                            && children(p).iter().any(|c| DECLARATOR_KINDS.contains(&c.kind()))
                        {
                            sym.shared_declaration = Some(true);
                        }
                    }
                }
                if is_list_member(node, parent, self.lang) {
                    sym.list_member = Some(true);
                }
                if let Some((line, offset)) = comment_start_row(parent, node, self.spec) {
                    if line < sym.start_line {
                        sym.comment_start_line = Some(line);
                        sym.comment_start_offset = Some(self.u16(offset as usize));
                    }
                }
                let child_scope = if is_container_kind(effective_kind) {
                    Scope::Class
                } else if is_callable_kind(effective_kind) {
                    Scope::Function
                } else {
                    Scope::Module
                };
                let inner = self.children_of(node, &qualified, child_scope);
                sym.children = inner;
                self.out.push(sym);
                return;
            }
        }

        // --- JS arrow/function assignments ------------------------------------
        if is_js(self.lang) && matches!(k, "lexical_declaration" | "variable_declaration") {
            let declarators: Vec<Node> = children(node).into_iter().filter(|c| c.kind() == "variable_declarator").collect();
            for declarator in &declarators {
                let value = declarator.child_by_field_name("value");
                let target = declarator.child_by_field_name("name");
                let callable = value
                    .map(|v| matches!(v.kind(), "arrow_function" | "function_expression" | "function" | "generator_function"))
                    .unwrap_or(false);
                let is_ident = target.map(|t| t.kind() == "identifier").unwrap_or(false);
                if !(is_ident && (callable || scope != Scope::Function)) {
                    continue;
                }
                let name = text_of(target.unwrap(), self.src);
                let qualified = match prefix {
                    Some(p) => format!("{}{}{}", p, self.sep, name),
                    None => name.clone(),
                };
                let kind = if callable {
                    "function"
                } else if value.map(|v| v.kind() == "object").unwrap_or(false) {
                    "object"
                } else {
                    "variable"
                };
                let (start_off, end_off) = if declarators.len() == 1 {
                    let s = if parent.map(|p| p.kind() == "export_statement").unwrap_or(false) {
                        parent.unwrap().start_byte()
                    } else {
                        node.start_byte()
                    };
                    (s, node.end_byte())
                } else {
                    (declarator.start_byte(), declarator.end_byte())
                };
                let mut sym = Symbol {
                    name: name.clone(),
                    qualified_name: qualified.clone(),
                    kind: kind.to_string(),
                    start_line: node.start_position().row as u32 + 1,
                    end_line: node.end_position().row as u32 + 1,
                    start_offset: self.u16(start_off),
                    end_offset: self.u16(end_off),
                    children: Vec::new(),
                    comment_start_line: None,
                    comment_start_offset: None,
                    shared_declaration: if declarators.len() > 1 { Some(true) } else { None },
                    list_member: None,
                };
                if let Some((line, offset)) = comment_start_row(parent, node, self.spec) {
                    if line < sym.start_line {
                        sym.comment_start_line = Some(line);
                        sym.comment_start_offset = Some(self.u16(offset as usize));
                    }
                }
                if let Some(v) = value {
                    let vscope = if callable { Scope::Function } else { Scope::Class };
                    sym.children = self.children_of(v, &qualified, vscope);
                }
                self.out.push(sym);
            }
            return;
        }

        // --- JS object-literal members ----------------------------------------
        if is_js(self.lang) && k == "pair" {
            let key = node.child_by_field_name("key");
            let value = node.child_by_field_name("value");
            if let Some(key) = key {
                if key.kind() == "property_identifier" {
                    let callable = value
                        .map(|v| matches!(v.kind(), "arrow_function" | "function_expression" | "function"))
                        .unwrap_or(false);
                    let kind = if callable {
                        "method"
                    } else if value.map(|v| v.kind() == "object").unwrap_or(false) {
                        "object"
                    } else {
                        "field"
                    };
                    let name = text_of(key, self.src);
                    let qualified = match prefix {
                        Some(p) => format!("{}{}{}", p, self.sep, name),
                        None => name.clone(),
                    };
                    let mut children_out = Vec::new();
                    if let Some(v) = value {
                        let vscope = if callable { Scope::Function } else { Scope::Class };
                        children_out = self.children_of(v, &qualified, vscope);
                    }
                    let slot = self.emit(node, name, kind, prefix, parent);
                    self.out[slot].children = children_out;
                }
            }
            return;
        }

        // --- Default: recurse -------------------------------------------------
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                self.collect(child, prefix, Some(node), scope);
            }
        }
    }
}

fn parser_for(lang: &'static str) -> Option<tree_sitter::Parser> {
    let mut parser = tree_sitter::Parser::new();
    let language: tree_sitter::Language = match lang {
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "c" => tree_sitter_c::LANGUAGE.into(),
        "cpp" => tree_sitter_cpp::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "c_sharp" => tree_sitter_c_sharp::LANGUAGE.into(),
        "lua" => tree_sitter_lua::LANGUAGE.into(),
        _ => return None,
    };
    if parser.set_language(&language).is_err() {
        return None;
    }
    Some(parser)
}