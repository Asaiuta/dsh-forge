//! Name matching + occurrence assignment, a faithful port of `findSymbol` and
//! `symbolOccurrences` in src/ast.ts. Match order is DFS pre-order (the `walk`
//! order), occurrences are assigned by `startOffset` ascending (stable), and a
//! query resolves exactly (qualifiedName or simple name) before falling back to
//! a suffix fuzzy match when the query is >= 3 chars — same precedence as the
//! WASM path, so the returned items line up 1:1.

use crate::symbol::Symbol;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchItem {
    pub qualified_name: String,
    pub kind: String,
    pub occurrence: u32,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_start_line: Option<u32>,
    pub signature: String,
}

fn walk<'a>(symbols: &'a [Symbol], out: &mut Vec<&'a Symbol>) {
    for s in symbols {
        out.push(s);
        walk(&s.children, out);
    }
}

pub fn match_file(
    symbols: &[Symbol],
    query: &str,
    kinds: Option<&[String]>,
    signatures: &BTreeMap<u32, String>,
) -> Vec<MatchItem> {
    let dotted = query.trim().replace("::", ".");
    let suffix = format!(".{dotted}");

    // Flatten once; keep DFS order for match precedence.
    let mut flat: Vec<&Symbol> = Vec::new();
    walk(symbols, &mut flat);

    // Occurrences: same qualifiedName, ordered by startOffset (stable -> matches
    // JS .sort over the same DFS flatten order).
    let mut sorted: Vec<&Symbol> = flat.clone();
    sorted.sort_by_key(|s| s.start_offset);
    let mut counters: HashMap<String, u32> = HashMap::new();
    let mut occurrence: HashMap<(String, u32), u32> = HashMap::new();
    for s in &sorted {
        let c = counters.entry(s.qualified_name.clone()).or_insert(0);
        *c += 1;
        occurrence.insert((s.qualified_name.clone(), s.start_offset), *c);
    }

    let mut exacts: Vec<&Symbol> = Vec::new();
    let mut fuzzies: Vec<&Symbol> = Vec::new();
    for s in &flat {
        let qn = s.qualified_name.replace("::", ".");
        if qn == dotted || s.name == dotted {
            exacts.push(s);
        } else if dotted.chars().count() >= 3
            && (qn.ends_with(&suffix) || s.name.ends_with(&dotted))
        {
            fuzzies.push(s);
        }
    }

    let matches: Vec<&Symbol> = if exacts.is_empty() { fuzzies } else { exacts };
    let mut out = Vec::with_capacity(matches.len());
    for s in matches {
        if let Some(kinds) = kinds {
            if !kinds.iter().any(|k| k == &s.kind) {
                continue;
            }
        }
        let occ = occurrence
            .get(&(s.qualified_name.clone(), s.start_offset))
            .copied()
            .unwrap_or(1);
        out.push(MatchItem {
            qualified_name: s.qualified_name.clone(),
            kind: s.kind.clone(),
            occurrence: occ,
            start_line: s.start_line,
            end_line: s.end_line,
            comment_start_line: s.comment_start_line,
            signature: signatures.get(&s.start_line).cloned().unwrap_or_default(),
        });
    }
    out
}