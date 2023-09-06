
export interface BrowserWindow {
  active: () => Promise<boolean>,
  onDidActiveChange?: (newState: boolean) => void,

  showFileInBrowser(absPath: string): void;
  showDirectoryPicker(): Promise<string|undefined>;
}
