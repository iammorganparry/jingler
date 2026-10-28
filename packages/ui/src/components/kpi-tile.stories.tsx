import type { Meta, StoryObj } from "@storybook/react-vite"
import { KpiTile, StackedMiniBar } from "./kpi-tile.js"

const meta: Meta = { title: "Molecules/KpiTile" }
export default meta
type Story = StoryObj

/** Usage KPI row (board 18b). Sample values are story fixtures, not product data. */
export const UsageRow: Story = {
  render: () => (
    <div className="grid w-[720px] grid-cols-4 gap-3 bg-editor p-6">
      <KpiTile label="Runs" value="128" delta="+12 vs prior 7d" />
      <KpiTile label="Tokens" value="4.1M" delta={<StackedMiniBar label="Tokens by model" values={[62, 25, 13]} />} />
      <KpiTile label="Cost" value="$18.40" partial delta="62% of runs priced" />
      <KpiTile label="Success" value="94%" />
    </div>
  )
}

/** A missing value shows the labelled "No data" placeholder; empty bars render an empty track. */
export const MissingData: Story = {
  render: () => (
    <div className="grid w-[720px] grid-cols-4 gap-3 bg-editor p-6">
      <KpiTile label="Success rate" value={null} delta="no completed runs" />
      <KpiTile label="Tokens" value="0" delta={<StackedMiniBar label="No tokens" values={[]} />} />
    </div>
  )
}
