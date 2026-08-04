import type { PlanBlock } from "@jingler/core"
import type { ReactNode } from "react"
import { MermaidDiagram } from "../../components/mermaid-diagram.js"
import { Markdown } from "../../components/markdown.js"

/**
 * The generative-UI block map: each `PlanBlock` kind renders through a maintained
 * React component. Prose/heading/list/code/table use the safe Markdown renderer
 * (constrained inline formatting, no raw HTML); diagrams render live via mermaid.
 * New widget kinds are added to the `PlanBlock` union in core and here together.
 */
const renderBlock = (block: PlanBlock): ReactNode => {
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
        <ol>
          {block.items.map((item, index) => (
            <li key={index}>
              <Markdown>{item}</Markdown>
            </li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}>
              <Markdown>{item}</Markdown>
            </li>
          ))}
        </ul>
      )
    case "code":
      return (
        <pre className="sb-plan-code">
          <code>{block.code}</code>
        </pre>
      )
    case "table":
      return (
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                {block.headers.map((header, index) => (
                  <th key={index}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case "diagram":
      return <MermaidDiagram source={block.source} />
  }
}

export interface PlanBlocksProps {
  readonly blocks: ReadonlyArray<PlanBlock>
  readonly className?: string
}

/** Render an ordered list of plan blocks, each keyed by its stable id. */
export function PlanBlocks({ blocks, className }: PlanBlocksProps) {
  if (blocks.length === 0) return null
  return (
    <div className={className} data-plan-blocks="true">
      {blocks.map((block) => (
        <div key={block.id} data-plan-block={block.id}>
          {renderBlock(block)}
        </div>
      ))}
    </div>
  )
}
