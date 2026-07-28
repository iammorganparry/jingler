import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import type { Attachment } from "@jingler/core"

/**
 * Where a transcript thumbnail gets its bytes, when the transcript did not carry
 * them.
 *
 * `Sessions.transcript` returns image attachments with `data` empty on purpose:
 * across the six largest transcripts on a real install, `Image` parts were 80%
 * of all bytes and `Text` was 1.5%, so loading a session meant pulling a
 * session's worth of base64 screenshots into the renderer and holding them for
 * the life of the conversation actor. Everything else about the message — id,
 * name, media type — still arrives, which is enough to render the tile.
 *
 * This is a CONTEXT rather than a prop because of where the two ends are. The
 * component that needs the bytes is `AttachmentThumb`, four levels inside a
 * virtualized transcript; the thing that can fetch them is the renderer's RPC
 * client, which `@jingler/ui` must not import — the package is consumed by
 * Storybook and by tests that have no main process to talk to. Threading a
 * resolver down as a prop would put it through `ConversationView`,
 * `MessageTurn` and every list in between, none of which have any other reason
 * to know images exist.
 *
 * The default resolver returns null, so Storybook and unit tests render the
 * placeholder instead of throwing. That is also the honest behaviour for a real
 * miss: an attachment whose chat was deleted has no bytes to find.
 */

/**
 * Takes the attachment's ID, not the attachment.
 *
 * Deliberate: the transcript is re-derived on every streamed token, so an
 * attachment OBJECT gets a fresh identity many times a second while the image it
 * describes never changes. A resolver keyed on the object would put that
 * identity into the fetching effect's dependencies and re-request every image on
 * screen on every frame of every turn. The id is the part that is actually
 * stable. Whatever else the resolver needs — which chat to look in — it closes
 * over at the provider.
 */
export type AttachmentResolver = (attachmentId: string) => Promise<string | null>

const NEVER_RESOLVES: AttachmentResolver = async () => null

const AttachmentSourceContext = createContext<AttachmentResolver>(NEVER_RESOLVES)

export function AttachmentSourceProvider({
  resolve,
  children
}: {
  resolve: AttachmentResolver
  children: ReactNode
}) {
  return (
    <AttachmentSourceContext.Provider value={resolve}>{children}</AttachmentSourceContext.Provider>
  )
}

/**
 * The attachment's base64, fetching it if the transcript did not include it.
 *
 * Returns `attachment.data` unchanged when it is already there — which is the
 * composer's case, where the operator just picked the file and the bytes are in
 * memory. Only a transcript thumbnail ever reaches the fetch.
 *
 * Null means "no bytes yet", covering both the in-flight window and a genuine
 * miss. Callers render a placeholder for both: distinguishing them would mean a
 * spinner on a tile that is 58px square.
 */
export const useAttachmentData = (attachment: Attachment): string | null => {
  const resolve = useContext(AttachmentSourceContext)
  const inline = attachment.data.length > 0 ? attachment.data : null
  const [fetched, setFetched] = useState<string | null>(null)

  const id = attachment.id

  useEffect(() => {
    if (inline !== null) return
    let live = true
    void resolve(id)
      .then((data) => {
        // `live` is the guard that matters in a VIRTUALIZED list: scrolling
        // unmounts a tile while its fetch is in flight, and a resolved promise
        // writing to a dead component is a warning at best and the wrong image
        // in a recycled tile at worst.
        if (live) setFetched(data)
      })
      .catch(() => {
        /* a missing attachment renders as a placeholder, never as an error */
      })
    return () => {
      live = false
    }
  }, [id, inline, resolve])

  return inline ?? fetched
}
