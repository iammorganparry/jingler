type Defaulted<Props, Defaults> = Props & {
  [Key in keyof Defaults]-?: Exclude<Props[Key & keyof Props], undefined> | Defaults[Key]
}

/** Apply component defaults to absent or undefined props, preserving explicit nulls. */
export function defaultProps<Props extends object, const Defaults extends object>(
  props: Props,
  defaults: Defaults & Partial<Props>
): Defaulted<Props, Defaults> {
  const result = { ...props } as Record<string, unknown>
  for (const [key, value] of Object.entries(defaults)) {
    if (result[key] === undefined) result[key] = value
  }
  return result as Defaulted<Props, Defaults>
}
