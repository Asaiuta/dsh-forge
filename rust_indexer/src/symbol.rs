//! The symbol tree emitted by the collector. JSON shape mirrors `AstSymbol`
//! in src/ast.ts so the TypeScript view/search helpers consume it unchanged:
//! optional fields are omitted when unset (serde skip_serializing_if).

use serde::Serialize;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub start_offset: u32,
    pub end_offset: u32,
    pub children: Vec<Symbol>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_start_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_declaration: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_member: Option<bool>,
}