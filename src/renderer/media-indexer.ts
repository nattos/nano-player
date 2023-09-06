import {} from 'lit/html';
import { Reader as jsmediatagsReader } from 'jsmediatags';
import * as utils from '../utils';
import * as constants from './constants';
import * as fileUtils from './file-utils';
import { Track, LibraryPathEntry, ArtworkRef } from './schema';
import { Database, UpdateMode } from './database';
import {Code} from './config';
import { createTrackEvaluator } from './code-eval';
import { PathsDirectoryHandle, PathsFileHandle, PathsHandle, createUrl, getFileOrAbsPath, revokeUrl, statFileHandle } from './paths';

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
  private readonly toAddQueue = new utils.AsyncProducerConsumerQueue<[PathsHandle, string]>();
  private readonly toIndexQueue = new utils.AsyncProducerConsumerQueue<string>();

  private readonly sortKeyEvaler = createTrackEvaluator(Code.LIBRARY_ORDER_KEY_CODE);
  private readonly groupingKeyEvaler = createTrackEvaluator(Code.GROUPING_KEY_CODE);

  start() {
    if (this.started) {
      return;
    }
    this.fileIndexerProc();
    for (const i of utils.range(constants.FILE_INDEXER_PARALLEL_COUNT)) {
      this.pathIndexerProc();
    }
  }

  queueFileHandle(handle: PathsHandle, subpath?: string) {
    this.toAddQueue.add([handle, subpath ?? '']);
  }

  updateMetadataForPath(trackPath: string) {
    this.toIndexQueue.add(trackPath);
  }

  private applyGeneratedMetadata(track: Track) {
    const sortKey = this.sortKeyEvaler(track) ?? '';
    const groupingKey = this.groupingKeyEvaler(track) ?? '';
    track.generatedMetadata = {
      librarySortKey: sortKey,
      groupingKey: groupingKey,
    };
  }

  private async fileIndexerProc() {
    await Database.instance.waitForLoad();

    const flow = new utils.BatchedProducerConsumerFlow<[PathsFileHandle, string[], LibraryPathEntry]>(16);
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
            ? fileUtils.enumerateFilesRec(await utils.getSubpathDirectory(handle as PathsDirectoryHandle, subpath))
            : [handle as PathsFileHandle];
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

    const audioMetadataInfoReader = new AudioMetadataInfoReader();

    while (true) {
      try {
        const path = await this.toIndexQueue.pop();
        const track = await Database.instance.fetchTrackByPath(path);
        const sourceKey = Database.getPathSourceKey(path);
        const filePath = Database.getPathFilePath(path);
        const fileName = utils.filePathFileName(filePath);
        const containingDirectoryPath = utils.filePathDirectory(filePath);
        const libraryPath = Database.instance.findLibraryPath(sourceKey);
        if (track === undefined || libraryPath === undefined) {
          continue;
        }

        let containingDirectory: PathsDirectoryHandle|undefined = undefined;
        if (libraryPath.directoryHandle) {
          containingDirectory = await utils.getSubpathDirectory(libraryPath.directoryHandle, containingDirectoryPath);
        }
        if (containingDirectory === undefined) {
          continue;
        }
        const fileHandle = await utils.getSubpathFile(containingDirectory, fileName);
        if (fileHandle === undefined) {
          continue;
        }
        const fileStats = await statFileHandle(fileHandle);
        const fileLastModifiedDate = fileStats.lastModified;

        let tags: JsMediaTags;
        try {
          tags = await this.readJsMediaTags(fileHandle);
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
        tags.tags.title ??= utils.filePathFileNameWithoutExtension(fileHandle.name);

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

        const audioMetadataInfo = await audioMetadataInfoReader.read(fileHandle);
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

        // Check if the updater actually changes anything.
        const dryRunModifiedTrack = structuredClone(trackShallowClone);
        trackUpdaterFunc((path) => path === track.path ? dryRunModifiedTrack : undefined);
        if (utils.isDeepStrictEqual(dryRunModifiedTrack, trackShallowClone)) {
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

  async readCoverArtFromFileMetadata(fileHandle: PathsFileHandle): Promise<Uint8Array|undefined> {
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

  private async readJsMediaTags(fileHandle: PathsFileHandle): Promise<JsMediaTags> {
    const file = await getFileOrAbsPath(fileHandle);
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
}


class AudioMetadataInfoReader {
  private readonly audioElement: HTMLAudioElement = new Audio();
  private audioMetadataReadResolvable?: utils.Resolvable<AudioMetadataInfo>;

  constructor() {
    this.audioElement.preload = 'metadata';
    this.audioElement.addEventListener('error', () => this.audioMetadataReadFailed());
    this.audioElement.addEventListener('abort', () => this.audioMetadataReadFailed());
    this.audioElement.addEventListener('loadedmetadata', () => this.audioMetadataReadSucceeded());
  }

  async read(fileHandle: PathsFileHandle): Promise<AudioMetadataInfo|undefined> {
    try {
      await this.audioMetadataReadResolvable?.promise;
    } catch {}
    try {
      const resultPromise = new utils.Resolvable<AudioMetadataInfo>();
      this.audioMetadataReadResolvable = resultPromise;
      if (this.audioElement.src) {
        const toRevoke = this.audioElement.src;
        this.audioElement.srcObject = null;
        revokeUrl(toRevoke);
      }
      this.audioElement.src = await createUrl(fileHandle);
      return await resultPromise.promise;
    } catch (e) {
      console.error(e);
      return undefined;
    } finally {
      this.audioMetadataReadResolvable = undefined;
    }
  }

  private audioMetadataReadFailed() {
    if (!this.audioElement.error) {
      return;
    }
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
