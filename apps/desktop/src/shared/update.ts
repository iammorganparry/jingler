export type UpdateState =
  | {
      readonly status: "available"
      readonly version: string
      readonly error?: string
      /**
       * This build cannot install updates itself (an unsigned macOS app: Squirrel
       * refuses to replace an app without a Developer ID signature), so the
       * action opens the new version's installer instead of downloading.
       */
      readonly manual?: true
    }
  | { readonly status: "downloading"; readonly version: string; readonly percent: number }
  | { readonly status: "downloaded"; readonly version: string }
