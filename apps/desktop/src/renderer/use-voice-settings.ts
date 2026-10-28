import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import type { VoiceSettingsProps } from "@jingler/ui"
import { rpc } from "./rpc-client.js"

/** Settings › Voice: model list (polled while a download runs), download/remove, and persisted prefs in `config.voice`. */
export function useVoiceSettings(): VoiceSettingsProps {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const models = useQuery({
    queryKey: ["voice-models"],
    queryFn: () => rpc.voiceModels(),
    refetchInterval: (query) => (query.state.data?.some((model) => model.downloading) ? 500 : false)
  })
  const config = useQuery({ queryKey: ["config"], queryFn: () => rpc.configGet() })
  const refresh = () => qc.invalidateQueries({ queryKey: ["voice-models"] })
  const download = useMutation({
    mutationFn: (id: string) => rpc.voiceDownloadModel(id),
    onMutate: () => setError(null),
    onError: (cause) => setError(cause instanceof Error ? cause.message : (cause as { message?: string })?.message ?? "Download failed"),
    onSettled: refresh
  })
  return {
    models: models.data ?? [],
    config: config.data?.voice ?? {},
    error,
    onSaveConfig: (voice) => void rpc.configSetVoice(voice).then((saved) => qc.setQueryData(["config"], saved)),
    onDownload: (id) => {
      download.mutate(id)
      void new Promise((r) => setTimeout(r, 100)).then(refresh)
    },
    onRemove: (id) => void rpc.voiceRemoveModel(id).then(refresh)
  }
}
