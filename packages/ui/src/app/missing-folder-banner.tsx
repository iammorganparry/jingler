import type { Project } from "@jingler/core"
import { FolderX } from "lucide-react"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"

/** A registered repo whose folder is gone from disk, with a Locate action. */
export function MissingFolderBanner({
  project,
  onLocate
}: {
  project?: Pick<Project, "id" | "name" | "availability">
  onLocate?: (projectId: string) => void | Promise<void>
}) {
  if (project?.availability !== "missing") return null
  return (
    <BannerShell
      placement="lane"
      icon={<FolderX size={14} />}
      actions={onLocate ? [
        <Button key="locate" size="sm" variant="secondary" onClick={() => void onLocate(project.id)}>Locate folder…</Button>
      ] : undefined}
    >
      {project.name}: folder not found
    </BannerShell>
  )
}
