export type UpdateState =
  | { readonly status: "available"; readonly version: string; readonly error?: string }
  | { readonly status: "downloading"; readonly version: string; readonly percent: number }
  | { readonly status: "downloaded"; readonly version: string }
