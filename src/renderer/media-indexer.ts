import {} from 'lit/html';
import { Reader as jsmediatagsReader } from 'jsmediatags';
import * as utils from '../utils';
import * as constants from './constants';
import * as fileUtils from './file-utils';
import { Track, LibraryPathEntry, ArtworkRef } from './schema';
import { Database, UpdateMode } from './database';

interface JsMediaTags {
  tags?: JsMediaTagsTags;
}

interface JsMediaTagsTags {
  album?: string;
  artist?: string;
  genre?: string;
  title?: string;
  track?: string;
  picture?: JsMediaTagsPicture;
}

interface JsMediaTagsPicture {
  format?: string;
  type?: string;
  description?: string;
  data?: Array<number>;
}

interface AudioMetadataInfo {
  duration?: number;
}

export class MediaIndexer {
  public static get instance() {
    if (!MediaIndexer.instanceField) {
      MediaIndexer.instanceField = new MediaIndexer();
    }
    return MediaIndexer.instanceField;
  }
  private static instanceField?: MediaIndexer;

  private started = false;
  private readonly toAddQueue = new utils.AsyncProducerConsumerQueue<[FileSystemHandle, string]>();
  private readonly toIndexQueue = new utils.AsyncProducerConsumerQueue<string>();
  private readonly audioElement: HTMLAudioElement = new Audio();
  private audioMetadataReadResolvable?: utils.Resolvable<AudioMetadataInfo>;

  start() {
    if (this.started) {
      return;
    }
    this.fileIndexerProc();
    for (const i of utils.range(constants.FILE_INDEXER_PARALLEL_COUNT)) {
      this.pathIndexerProc();
    }

    this.audioElement.preload = 'metadata';
    this.audioElement.addEventListener('error', () => this.audioMetadataReadFailed());
    this.audioElement.addEventListener('abort', () => this.audioMetadataReadFailed());
    this.audioElement.addEventListener('loadedmetadata', () => this.audioMetadataReadSucceeded());
  }

  queueFileHandle(handle: FileSystemHandle, subpath?: string) {
    this.toAddQueue.add([handle, subpath ?? '']);
  }

  updateMetadataForPath(trackPath: string) {
    this.toIndexQueue.add(trackPath);
  }

  private applyGeneratedMetadata(track: Track) {
    const sortKey = [
      utils.filePathDirectory(Database.getPathFilePath(track.path)), // TODO: Reverse path parts
      track.metadata?.album,
      utils.formatIntPadded(track.metadata?.diskNumber ?? 0, 3),
      utils.formatIntPadded(track.metadata?.trackNumber ?? 0, 3),
      track.metadata?.title,
    ].join('\x00');
    track.generatedMetadata = {
      librarySortKey: sortKey
    };
  }

  private async fileIndexerProc() {
    await Database.instance.waitForLoad();

    const flow = new utils.BatchedProducerConsumerFlow<[FileSystemFileHandle, string[], LibraryPathEntry]>(16);
    flow.consume(async (entries) => {
      try {
        const toUpdatePaths: string[] = [];
        for (const [fileHandle, pathParts, libraryPath] of entries) {
          const path = Database.makePath(libraryPath.path, pathParts);
          toUpdatePaths.push(path);
        }
        const insertedPaths = await Database.instance.updateTracks(toUpdatePaths, UpdateMode.CreateOnly, (trackGetter) => {
          for (const [fileHandle, pathParts, libraryPath] of entries) {
            const path = Database.makePath(libraryPath.path, pathParts);
            const toUpdate = trackGetter(path);
            if (toUpdate === undefined) {
              continue;
            }
            toUpdate.fileHandle = fileHandle;
            toUpdate.addedDate = Date.now();
            toUpdate.metadata = {
              title: utils.filePathFileNameWithoutExtension(fileHandle.name),
            };
            this.applyGeneratedMetadata(toUpdate);
          }
        });
        this.toIndexQueue.addRange(toUpdatePaths);
      } catch (e) {
        console.error(e);
      }
    });

    while (true) {
      try {
        // TODO: Handle deletions!
        const [handle, subpath] = await this.toAddQueue.pop();
        const filesIt = handle.kind === 'directory'
            ? fileUtils.enumerateFilesRec(await utils.getSubpathDirectory(handle as FileSystemDirectoryHandle, subpath))
            : [handle as FileSystemFileHandle];
        for await (const foundFile of filesIt) {
          console.log(foundFile);
          const fileName = foundFile.name.toLocaleLowerCase();
          if (!constants.INDEXED_FILES_PATTERN.test(fileName)) {
            console.log(`ignored: ${foundFile}`);
            continue;
          }

          const resolvedLibraryPath = await Database.instance.resolveInLibraryPaths(foundFile);
          if (!resolvedLibraryPath.libraryPath || !resolvedLibraryPath.subpath) {
            console.log(`not in library path: ${foundFile}`);
            continue;
          }
          console.log(`adding: ${foundFile} in ${resolvedLibraryPath.libraryPath.path}`);
          flow.produce([foundFile, resolvedLibraryPath.subpath, resolvedLibraryPath.libraryPath]);
        }

        flow.flushProduced();
      } catch (e) {
        console.error(e);
      }
    }
  }

  private async pathIndexerProc() {
    await Database.instance.waitForLoad();

    while (true) {
      try {
        const path = await this.toIndexQueue.pop();
        const track = await Database.instance.fetchTrackByPath(path);
        const sourceKey = Database.getPathSourceKey(path);
        const containingDirectoryPath = utils.filePathDirectory(Database.getPathFilePath(path));
        const libraryPath = Database.instance.findLibraryPath(sourceKey);
        if (track?.fileHandle === undefined || libraryPath === undefined) {
          continue;
        }
        const file = await track.fileHandle.getFile();
        const fileLastModifiedDate = file.lastModified;

        let containingDirectory: FileSystemDirectoryHandle|undefined = undefined;
        if (libraryPath.directoryHandle) {
          containingDirectory = await utils.getSubpathDirectory(libraryPath.directoryHandle, containingDirectoryPath);
        }

        let tags: JsMediaTags;
        try {
          tags = await this.readJsMediaTags(track.fileHandle);
          console.log(tags);
        } catch (e) {
          if ((e as any)?.type === 'tagFormat') {
            tags = {};
          } else {
            throw e;
          }
        }
        if (!tags) {
          tags = {};
        }
        if (!tags.tags) {
          tags.tags = {};
        }
        tags.tags.title ??= utils.filePathFileNameWithoutExtension(file.name);

        let coverArtRef: ArtworkRef|undefined = undefined;
        if (containingDirectory) {
          const allFiles = await utils.arrayFromAsync(fileUtils.enumerateImmediateFiles(containingDirectory));
          const coverArtFile = allFiles.find(file => constants.COVER_ART_FILE_PATTERN.test(file.name.toLocaleLowerCase()));
          if (coverArtFile) {
            const coverArtFilePath = Database.makePath(sourceKey, [containingDirectoryPath, coverArtFile.name]);
            coverArtRef = { fromImageFileAtPath: coverArtFilePath };
          }
        }
        if (!coverArtRef) {
          if (tags.tags.picture) {
            coverArtRef = { fromImageInFileMetadataAtPath: path };
          }
        }

        const audioMetadataInfo = await this.readAudioMetadataInfo(file);
        const duration = audioMetadataInfo?.duration;

        const trackNumberParts = tags?.tags?.track?.split('/');
        const trackNumber = utils.parseIntOr(trackNumberParts?.at(0));
        const trackTotal = utils.parseIntOr(trackNumberParts?.at(1));

        let toSetIndexedDate = track.indexedDate;
        const trackUpdaterFunc = (trackGetter: (path: string) => Track|undefined) => {
          const toUpdate = trackGetter(path);
          if (toUpdate === undefined) {
            return;
          }
          toUpdate.metadata = {
            // Must set these to empty strings because Database does this anyways
            // because these are listed in SORT_CONTEXTS_TO_METADATA_PATH.
            artist: tags?.tags?.artist ?? '',
            album: tags?.tags?.album ?? '',
            genre: tags?.tags?.genre ?? '',
            title: tags?.tags?.title ?? '',
            trackNumber: trackNumber,
            trackTotal: trackTotal,
            // diskNumber: ???,
            // diskTotal: ???,
            duration: duration,
            // coverArtSummary: ???,
          };
          toUpdate.indexedDate = toSetIndexedDate;
          toUpdate.indexedAtLastModifiedDate = fileLastModifiedDate;
          toUpdate.coverArt = coverArtRef;
          this.applyGeneratedMetadata(toUpdate);
        };

        // Excise values structuredClone can't handle.
        const trackShallowClone = utils.merge({}, track);
        trackShallowClone.fileHandle = undefined;

        // Check if the updater actually changes anything.
        const dryRunModifiedTrack = structuredClone(trackShallowClone);
        trackUpdaterFunc((path) => path === track.path ? dryRunModifiedTrack : undefined);
        if (utils.isDeepStrictEqual(dryRunModifiedTrack, track)) {
          console.log(`Indexed: ${track.path} (unchanged)`);
          continue;
        }

        toSetIndexedDate = Date.now();
        Database.instance.updateTracks([path], UpdateMode.UpdateOnly, trackUpdaterFunc);
      } catch (e) {
        console.error(e);
      }
    }
  }

  async readCoverArtFromFileMetadata(fileHandle: FileSystemFileHandle): Promise<Uint8Array|undefined> {
    try {
      const tags = await this.readJsMediaTags(fileHandle);
      const bytesArray = tags.tags?.picture?.data;
      if (bytesArray === undefined) {
        return undefined;
      }
      return new Uint8Array(bytesArray);
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }

  private async readJsMediaTags(fileHandle: FileSystemFileHandle): Promise<JsMediaTags> {
    const file = await fileHandle.getFile();
    const tagsReader = new jsmediatagsReader(file);

    let tagsResolve: (value: {}) => void = () => {};
    let tagsReject: (reason: any) => void = () => {};
    const tagsPromise = new Promise<{}>((resolve, reject) => { tagsResolve = resolve; tagsReject = reject; });
    tagsReader.read({
      onSuccess: tagsResolve,
      onError: tagsReject,
    });

    let tags: JsMediaTags;
    try {
      tags = await tagsPromise;
      // console.log(tags);
    } catch (e) {
      if ((e as any)?.type === 'tagFormat') {
        tags = {};
      } else {
        throw e;
      }
    }
    return tags;
  }

  private async readAudioMetadataInfo(file: File): Promise<AudioMetadataInfo|undefined> {
    try {
      await this.audioMetadataReadResolvable?.promise;
    } catch {}
    try {
      const resultPromise = new utils.Resolvable<AudioMetadataInfo>();
      this.audioMetadataReadResolvable = resultPromise;
      if (this.audioElement.src) {
        const toRevoke = this.audioElement.src;
        this.audioElement.src = '';
        URL.revokeObjectURL(toRevoke);
      }
      this.audioElement.src = URL.createObjectURL(file);
      return await resultPromise.promise;
    } catch (e) {
      console.error(e);
      return undefined;
    } finally {
      this.audioMetadataReadResolvable = undefined;
    }
  }

  private audioMetadataReadFailed() {
    this.audioMetadataReadResolvable?.reject(this.audioElement.error?.message);
    this.audioMetadataReadResolvable = undefined;
    if (this.audioElement.srcObject) {
      this.audioElement.srcObject = null;
    }
  }

  private audioMetadataReadSucceeded() {
    this.audioMetadataReadResolvable?.resolve({
      duration: this.audioElement.duration,
    });
    this.audioMetadataReadResolvable = undefined;
    if (this.audioElement.srcObject) {
      this.audioElement.srcObject = null;
    }
  }
}
