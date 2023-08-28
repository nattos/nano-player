
export interface BrowserWindow {
  active: () => Promise<boolean>,
  onDidActiveChange?: (newState: boolean) => void,
}
