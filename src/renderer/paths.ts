import * as utils from '../utils';
import * as environment from './environment';
import { getBrowserWindow } from './renderer-ipc';

const lazyFs = utils.lazyOr(async () => environment.isElectron() ? await import('fs') : undefined);

export type PathsType = 'file'|'directory';

export interface PathsHandle {
  kind: PathsType;
  name: string;
  queryPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
}

export interface PathsDirectoryHandle extends PathsHandle {
  values(): AsyncIterable<PathsHandle>;
  getDirectoryHandle(name: string): Promise<PathsDirectoryHandle>;
  getFileHandle(name: string): Promise<PathsFileHandle>;
  resolve(handle: PathsHandle): Promise<string[]|null>;
}

export interface PathsFileHandle extends PathsHandle {
}

export interface FileStats {
  readonly lastModified: number;
}

export async function getHandleFromAbsPath(absPath: string): Promise<PathsHandle|undefined> {
  if (environment.isElectron()) {
    const fs = await lazyFs();
    const stats = (await fs!.promises.stat(absPath));
    const isFile = stats.isFile();
    const isDirectory = stats.isDirectory();
    if (isDirectory) {
      return new FsDirectoryHandle(absPath);
    } else if (isFile) {
      return new FsFileHandle(absPath);
    } else {
      return undefined;
    }
  }
  return undefined;
}

export async function statFileHandle(handle: PathsHandle): Promise<FileStats> {
  const fsHandle = handle as FsHandle;
  if (fsHandle.isFsHandle) {
    const fs = await lazyFs();
    const stats = await fs!.promises.stat(fsHandle.absPath);
    return {
      lastModified: stats.mtimeMs,
    };
  }
  return await (fsHandle as unknown as FileSystemFileHandle).getFile();
}

export function getFileOrAbsPath(handle: PathsFileHandle): Promise<File|string> {
  const fsHandle = handle as FsFileHandle;
  if (fsHandle.isFsHandle) {
    return Promise.resolve(fsHandle.absPath);
  }
  return (fsHandle as unknown as FileSystemFileHandle).getFile();
}

export async function createUrl(handle: PathsFileHandle): Promise<string> {
  const fsHandle = handle as FsFileHandle;
  if (fsHandle.isFsHandle) {
    return encodeURI(`file://${fsHandle.absPath}`).replaceAll('#', '%23');
  }
  return URL.createObjectURL(await (fsHandle as unknown as FileSystemFileHandle).getFile());
}

export function revokeUrl(url: string) {
  if (url.startsWith('file://')) {
    return;
  }
  URL.revokeObjectURL(url);
}

export async function showDirectoryPicker(): Promise<PathsDirectoryHandle|undefined> {
  if (environment.isElectron()) {
    let path = await getBrowserWindow()?.showDirectoryPicker();
    if (path) {
      if (!path.endsWith('/')) {
        path += '/';
      }
      return new FsDirectoryHandle(path);
    }
    return undefined;
  }
  return await (window as any).showDirectoryPicker() as PathsDirectoryHandle;
}

export async function handlesFromDataTransfer(dataTransfer: DataTransfer): Promise<PathsHandle[]> {
  if (environment.isElectron()) {
    const absPaths: string[] = [];
    for (const item of dataTransfer.files) {
      absPaths.push(item.path);
    }
    const fs = await lazyFs();
    return Promise.all(absPaths.map(async absPath => {
      const isDirectory = (await fs!.promises.stat(absPath)).isDirectory();
      if (isDirectory) {
        return new FsDirectoryHandle(absPath);
      } else {
        return new FsFileHandle(absPath);
      }
    }));
  } else {
    const files: DataTransferItem[] = [];
    for (const item of dataTransfer.items) {
      if (item.kind !== 'file') {
        continue;
      }
      files.push(item);
    }
    // TODO: Deal with API.
    const fileHandles = await Promise.all(files.map(file => (file as any).getAsFileSystemHandle() as Promise<PathsHandle>));
    return fileHandles;
  }
}

export function deserializePathsHandle<T extends PathsHandle>(serialized: T|undefined): T|undefined {
  if (serialized === undefined) {
    return undefined;
  }
  if ((serialized as any).isFsHandle) {
    if (serialized.kind === 'file') {
      return FsFileHandle.deserialize(serialized as unknown as FsFileHandle) as unknown as T;
    } else if (serialized.kind === 'directory') {
      return FsDirectoryHandle.deserialize(serialized as unknown as FsDirectoryHandle) as unknown as T;
    }
    return undefined;
  }
  return serialized;
}

export function makeRootDirectoryHandle(): PathsDirectoryHandle|undefined {
  if (environment.isElectron()) {
    return new FsDirectoryHandle('/');
  }
  return undefined;
}

abstract class FsHandle implements PathsHandle {
  readonly isFsHandle = true;
  abstract kind: PathsType;
  readonly name: string;

  constructor(readonly absPath: string) {
    const path = absPath.endsWith('/') ? absPath.substring(0, absPath.length - 1) : absPath;
    this.name = utils.filePathFileName(path);
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
}

class FsFileHandle extends FsHandle implements PathsFileHandle {
  override kind: PathsType = 'file';

  constructor(absPath: string) {
    super(absPath);
  }

  static deserialize(serialized: FsFileHandle): FsFileHandle {
    return new FsFileHandle(serialized.absPath);
  }
}

class FsDirectoryHandle extends FsHandle implements PathsDirectoryHandle {
  override kind: PathsType = 'directory';

  constructor(absPath: string) {
    super(absPath);
  }

  async * values(): AsyncIterable<PathsHandle> {
    const fs = await lazyFs();
    const files = await fs!.promises.readdir(this.absPath);
    for (const file of files) {
      const childAbsPath = this.absPath + file;
      const isDirectory = (await fs!.promises.stat(childAbsPath)).isDirectory();
      if (isDirectory) {
        yield new FsDirectoryHandle(childAbsPath + '/');
      } else {
        yield new FsFileHandle(childAbsPath);
      }
    }
  }
  async getDirectoryHandle(name: string): Promise<PathsDirectoryHandle> {
    if (!name.endsWith('/')) {
      name += '/';
    }
    return new FsDirectoryHandle(this.absPath + name);
  }
  async getFileHandle(name: string): Promise<PathsFileHandle> {
    return new FsFileHandle(this.absPath + name);
  }
  async resolve(handle: PathsHandle): Promise<string[]|null> {
    const fsHandle = handle as FsHandle;
    if (!fsHandle.isFsHandle) {
      return null;
    }
    if (fsHandle.absPath.startsWith(this.absPath)) {
      const subpath = fsHandle.absPath.substring(this.absPath.length);
      return subpath.split('/');
    }
    return null;
  }
  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }

  static deserialize(serialized: FsDirectoryHandle): FsDirectoryHandle {
    return new FsDirectoryHandle(serialized.absPath);
  }
}
