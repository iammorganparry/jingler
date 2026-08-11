/** True only inside Jingler's built Electron end-to-end process. */
export const isE2eEnv = (): boolean => process.env.JINGLER_E2E === "1"
