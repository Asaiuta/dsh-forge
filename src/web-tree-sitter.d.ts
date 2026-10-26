/**
 * Minimal ambient types for web-tree-sitter 0.25 — its package.json exports
 * map does not surface the shipped web-tree-sitter.d.ts, so we declare the
 * slice of the API dsh-forge uses. Kept hand-written and tiny on purpose.
 */

declare module 'web-tree-sitter' {
  export interface Point {
    row: number
    column: number
  }

  export interface Node {
    readonly isNamed: boolean
    readonly type: string
    readonly text: string
    readonly children: Node[]
    readonly namedChildren: Array<Node | null>
    readonly childCount: number
    readonly parent: Node | null
    /** Stable per-tree node identity (wrappers are not reference-stable). */
    readonly id: number
    readonly startPosition: Point
    readonly endPosition: Point
    readonly startIndex: number
    readonly endIndex: number
    readonly hasError: boolean
    childForFieldName(fieldName: string): Node | null
    childrenForFieldName(fieldName: string): (Node | null)[]
    descendantsOfType(types: string | string[]): Array<Node | null>
  }

  export interface Tree {
    readonly rootNode: Node
    delete(): void
  }

  export interface Language {
    readonly name: string
  }

  export class Parser {
    constructor(language?: Language)
    static init(modules?: unknown): Promise<void>
    setLanguage(language: Language): void
    parse(input: string, oldTree?: Tree): Tree | null
  }

  export const Language: {
    load(input: string | Uint8Array): Promise<Language>
  }
}
