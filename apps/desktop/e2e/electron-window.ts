import type { ElectronApplication } from "@playwright/test";

/** Make an explicitly headed Electron QA launch visible and interactive. */
export const showElectronWindow = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
