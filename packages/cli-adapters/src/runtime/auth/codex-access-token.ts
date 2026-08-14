import { Either, Schema } from "effect"

const AccountId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(160)
)

const CodexAccessClaims = Schema.Struct({
  chatgpt_account_id: Schema.optional(AccountId),
  "https://api.openai.com/auth": Schema.optional(
    Schema.Struct({ chatgpt_account_id: Schema.optional(AccountId) })
  )
})

/** Decode only the account-routing claim needed by the managed Codex proxy. */
export const codexAccountIdFromAccessToken = (access: string): string | null => {
  const payload = access.split(".")[1]
  if (payload === undefined) return null
  try {
    const decoded = Schema.decodeUnknownEither(CodexAccessClaims)(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      { onExcessProperty: "ignore" }
    )
    if (Either.isLeft(decoded)) return null
    return decoded.right.chatgpt_account_id ??
      decoded.right["https://api.openai.com/auth"]?.chatgpt_account_id ??
      null
  } catch {
    return null
  }
}
