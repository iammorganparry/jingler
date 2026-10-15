/** Renders `text` with the first case-insensitive occurrence of `query` emphasised. */
export function HighlightMatch({ text, query }: { text: string; query: string }) {
  const needle = query.trim()
  const at = needle === "" ? -1 : text.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-text-bright">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}
