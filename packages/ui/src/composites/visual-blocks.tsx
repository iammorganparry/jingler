import type { VisualBlock } from "@jingler/core"
import type { ReactNode } from "react"
import { MermaidDiagram } from "../components/mermaid-diagram.js"
import { Markdown } from "../components/markdown.js"
import { PlanChangeBlock } from "./plan-change-block.js"

const positionalKey = (index: number, value: string): string => `${index}:${value}`

const renderBlock = (block: VisualBlock): ReactNode => {
  switch (block.kind) {
    case "prose":
      return <Markdown>{block.text}</Markdown>
    case "heading":
      return block.level === 2 ? (
        <h2 className="sb-plan-heading">{block.text}</h2>
      ) : block.level === 3 ? (
        <h3 className="sb-plan-heading">{block.text}</h3>
      ) : (
        <h4 className="sb-plan-heading">{block.text}</h4>
      )
    case "list":
      return block.ordered ? (
        <ol>{block.items.map((item, index) => <li key={positionalKey(index, item)}><Markdown>{item}</Markdown></li>)}</ol>
      ) : (
        <ul>{block.items.map((item, index) => <li key={positionalKey(index, item)}><Markdown>{item}</Markdown></li>)}</ul>
      )
    case "code":
      return <pre className="sb-plan-code"><code>{block.code}</code></pre>
    case "table":
      return (
        <div className="overflow-x-auto">
          <table>
            <thead><tr>{block.headers.map((header, index) => <th key={positionalKey(index, header)}>{header}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={positionalKey(rowIndex, row.join("\u001f"))}>
                  {row.map((cell, cellIndex) => (
                    <td key={positionalKey(cellIndex, cell)}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case "diagram":
      return <MermaidDiagram source={block.source} />
    case "change":
      return <PlanChangeBlock path={block.path} patch={block.patch} />
  }
}

export interface VisualBlocksProps {
  readonly blocks: ReadonlyArray<VisualBlock>
  readonly className?: string
}

/** Maintained renderer for safe structured visual blocks shared by plans and explanations. */
export function VisualBlocks({ blocks, className }: VisualBlocksProps) {
  if (blocks.length === 0) return null
  return (
    <div className={className} data-visual-blocks="true" data-plan-blocks="true">
      {blocks.map((block) => (
        <div key={block.id} data-visual-block={block.id} data-plan-block={block.id}>
          {renderBlock(block)}
        </div>
      ))}
    </div>
  )
}
