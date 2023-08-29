
export function enumerateImmediateFiles(directory: FileSystemDirectoryHandle) {
  // TODO: API not available.
  return (directory as any).values() as AsyncIterable<FileSystemHandle>;
}

export async function* enumerateFilesRec(directory: FileSystemDirectoryHandle|undefined) {
  if (!directory) {
    return;
  }
  const toVisitQueue = [directory];
  while (true) {
    const toVisit = toVisitQueue.pop();
    if (!toVisit) {
      break;
    }

    const children = enumerateImmediateFiles(toVisit);
    for await (const child of children) {
      if (child.kind === 'directory') {
        toVisitQueue.push(child as FileSystemDirectoryHandle);
      } else {
        yield child as FileSystemFileHandle;
      }
    }
  }
}
