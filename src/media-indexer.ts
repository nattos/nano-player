import { openDB, deleteDB, IDBPDatabase, IDBPObjectStore, IDBPTransaction } from 'idb';
import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, property, query} from 'lit/decorators.js';
import { styleMap } from 'lit-html/directives/style-map.js';
import { action, autorun, runInAction, observable, observe, makeObservable } from 'mobx';
import { Reader as jsmediatagsReader } from 'jsmediatags';
import { RecyclerView } from './recycler-view';
import { CandidateCompletion, CommandResolvedArg, CommandSpec, CommandParser } from './command-parser';
import * as utils from './utils';
import * as constants from './constants';
import { TrackView, TrackViewHost } from './track-view';
import { Track, LibraryPathEntry, TrackPrefix, SearchTableEntry } from './schema';
import { Database } from './database';

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
  data?: Uint8Array;
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
  private readonly toAddQueue = new utils.AsyncProducerConsumerQueue<FileSystemHandle>();
  private readonly toIndexQueue = new utils.AsyncProducerConsumerQueue<string>();
  private readonly audioElement: HTMLAudioElement = new Audio();
  private audioMetadataReadResolvable?: utils.Resolvable<AudioMetadataInfo>;

  start() {
    if (this.started) {
      return;
    }
    this.fileIndexerProc();
    this.pathIndexerProc();

    this.audioElement.preload = 'metadata';
    this.audioElement.addEventListener('error', () => this.audioMetadataReadFailed());
    this.audioElement.addEventListener('abort', () => this.audioMetadataReadFailed());
    this.audioElement.addEventListener('loadedmetadata', () => this.audioMetadataReadSucceeded());
  }

  queueFileHandle(handle: FileSystemHandle) {
    this.toAddQueue.add(handle);
  }

  private applyGeneratedMetadata(track: Track) {
    const sortKey = [
      track.metadata?.album,
      utils.formatIntPadded(track.metadata?.diskNumber ?? 0, 3),
      utils.formatIntPadded(track.metadata?.trackNumber ?? 0, 3),
      Database.getPathFilePath(track.path), // TODO: Reverse path parts
    ].join('\x00');
    track.generatedMetadata = {
      librarySortKey: sortKey
    };
  }

  private async fileIndexerProc() {
    const flow = new utils.BatchedProducerConsumerFlow<[FileSystemFileHandle, string[], LibraryPathEntry]>(16);
    flow.consume(async (entries) => {
      try {
        const tracks: Track[] = [];
        for (const [fileHandle, pathParts, libraryPath] of entries) {
          const path = Database.makePath(libraryPath.path, pathParts);
          const track = {
            path: path,
            fileHandle: fileHandle,
            addedDate: Date.now(),
            indexedDate: 0,
            indexedAtLastModifiedDate: 0,
          };
          this.applyGeneratedMetadata(track);
          tracks.push(track);
        }
        const insertedPaths = await Database.instance.updateTracks(tracks, 'create_only');
        // this.toIndexQueue.addRange(insertedPaths);
        this.toIndexQueue.addRange(tracks.map(track => track.path));
      } catch (e) {
        console.error(e);
      }
    });

    while (true) {
      try {
        // TODO: Handle deletions!
        const handle = await this.toAddQueue.pop();
        const filesIt = handle.kind === 'directory'
            ? this.enumerateFilesRec(handle as FileSystemDirectoryHandle)
            : [handle as FileSystemFileHandle];
        for await (const foundFile of filesIt) {
          console.log(foundFile);
          const fileName = foundFile.name.toLocaleLowerCase();
          if (!constants.INDEXED_FILES_PATTERN.test(fileName)) {
            console.log(`ignored: ${foundFile}`);
            continue;
          }

          const libraryPaths = Database.instance.getLibraryPaths();
          let containedLibraryPath: LibraryPathEntry|null = null;
          for (const libraryPath of libraryPaths) {
            // TODO: Deal with permissions.
            if (!libraryPath.directoryHandle) {
              continue;
            }
            const resolvedPath = await libraryPath.directoryHandle.resolve(foundFile);
            if (!resolvedPath) {
              // Can't handle ephemeral paths yet.
              console.log(`not in library path: ${foundFile}`);
              continue;
            }
            console.log(`adding: ${foundFile} in ${libraryPath.path}`);
            flow.produce([foundFile, resolvedPath, libraryPath]);
          }
        }

        flow.flushProduced();
      } catch (e) {
        console.error(e);
      }
    }
  }

  private async* enumerateFilesRec(directory: FileSystemDirectoryHandle) {
    const toVisitQueue = [directory];
    while (true) {
      const toVisit = toVisitQueue.pop();
      if (!toVisit) {
        break;
      }

      // TODO: API not available.
      const children = (toVisit as any).values() as AsyncIterable<FileSystemHandle>;
      for await (const child of children) {
        if (child.kind === 'directory') {
          toVisitQueue.push(child as FileSystemDirectoryHandle);
        } else {
          yield child as FileSystemFileHandle;
        }
      }
    }
  }

  private async pathIndexerProc() {
    while (true) {
      try {
        const path = await this.toIndexQueue.pop();
        const track = await Database.instance.fetchTrackByPath(path);
        if (track?.fileHandle === undefined) {
          continue;
        }
        const file = await track.fileHandle.getFile();
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
          console.log(tags);
        } catch (e) {
          if ((e as any)?.type === 'tagFormat') {
            tags = {
              tags: {
                title: utils.filePathWithoutExtension(file.name),
              }
            };
          } else {
            throw e;
          }
        }

        const audioMetadataInfo = await this.readAudioMetadataInfo(file);
        const duration = audioMetadataInfo?.duration;

        const trackNumberParts = tags?.tags?.track?.split('/');
        const trackNumber = utils.parseIntOr(trackNumberParts?.at(0));
        const trackTotal = utils.parseIntOr(trackNumberParts?.at(1));

        track.metadata = {
          artist: tags?.tags?.artist,
          album: tags?.tags?.album,
          genre: tags?.tags?.genre,
          title: tags?.tags?.title,
          trackNumber: trackNumber,
          trackTotal: trackTotal,
          // diskNumber: ???,
          // diskTotal: ???,
          duration: duration,
          // coverArtSummary: ???,
        };
        Database.instance.updateTracks([track], 'update_only');
      } catch (e) {
        console.error(e);
      }
    }
  }

  private async readAudioMetadataInfo(file: File): Promise<AudioMetadataInfo|undefined> {
    try {
      await this.audioMetadataReadResolvable?.promise;
    } catch {}
    try {
      const resultPromise = new utils.Resolvable<AudioMetadataInfo>();
      this.audioMetadataReadResolvable = resultPromise;
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
    this.audioElement.src = '';
  }

  private audioMetadataReadSucceeded() {
    this.audioMetadataReadResolvable?.resolve({
      duration: this.audioElement.duration,
    });
    this.audioMetadataReadResolvable = undefined;
    this.audioElement.src = '';
  }
}
