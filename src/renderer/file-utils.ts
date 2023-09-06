import { PathsDirectoryHandle, PathsFileHandle } from "./paths";

export function enumerateImmediateFiles(directory: PathsDirectoryHandle) {
  // TODO: API not available.
  return directory.values();
}

export async function* enumerateFilesRec(directory: PathsDirectoryHandle|undefined) {
  if (!directory) {
    return;
  }
  const toVisitQueue = [directory];
  while (true) {
    const toVisit = toVisitQueue.pop();
    if (!toVisit) {
      break;
    }

    const children = toVisit.values();
    for await (const child of children) {
      if (child.kind === 'directory') {
        toVisitQueue.push(child as PathsDirectoryHandle);
      } else {
        yield child as PathsFileHandle;
      }
    }
  }
}
