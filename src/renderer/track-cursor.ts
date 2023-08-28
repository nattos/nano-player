import { ListPrimarySource, Database, SortContext, ListSource } from "./database";
import { Track } from "./schema";
import * as utils from '../utils';
import * as constants from './constants';
import { NanoApp } from "./app";

export interface TrackPositionAnchor {
  index: number;
  path: string;
}

export interface TrackUpdatedResults {
  rebasedStartIndex: number;
  rebasedEndIndex: number;
  rebasedDelta?: number;
  results: Iterable<Track|undefined>;
  totalCount: number;
}

export interface TrackPeekResult {
  contextChanged: boolean;
  dirtyResults: TrackUpdatedResults;
  updatedResultsPromise: Promise<TrackUpdatedResults>|undefined;
}

export class TrackCursor {
  private static readonly cachedBlockCount = 64;
  private static readonly blockSize = 128;

  private sourceField: ListSource;

  private databaseDirty = true;
  private tracksDirty = false;
  private currentIndex = 0;
  private cachedTrackCount = 0;

  private readonly cachedBlocks = new utils.LruCache<number, Track[]>(TrackCursor.cachedBlockCount);
  private readonly invalidatedBlocks = new Map<number, Track[]>();
  private readonly fetchesInFlight = new Map<number, Promise<Track[]>>();

  private cachedPrimarySource: ListPrimarySource;
  private cachedSecondarySource?: string;
  private cachedSortContext?: SortContext;
  private cachedSearchContextEpoch: number;
  private cachedListChangeEpoch: number;

  readonly onCachedTrackInvalidated = utils.multicast();

  constructor(
      public readonly database: Database,
      primarySource: ListPrimarySource,
      secondarySource: string|undefined,
      sortContext: SortContext|undefined,
      public anchor?: TrackPositionAnchor,
      ) {
    this.sourceField = {
      source: primarySource,
      secondary: secondarySource,
      sortContext: sortContext,
    };
    const resolvedSource = NanoApp.instance!.resolveSource(this.sourceField);
    this.cachedPrimarySource = resolvedSource.source;
    this.cachedSecondarySource = resolvedSource.secondary;
    this.cachedSortContext = resolvedSource.sortContext;
    this.cachedSearchContextEpoch = this.database.searchContextEpoch;
    this.cachedListChangeEpoch = this.database.listChangeEpoch;
    this.database.onTrackPathsUpdated.add(this.boundOnDatabaseTrackPathsUpdated);
  }

  dispose() {
    this.database.onTrackPathsUpdated.remove(this.boundOnDatabaseTrackPathsUpdated);
  }

  get source() { return this.sourceField; }
  set source(source: ListSource) {
    this.sourceField.source = source.source;
    this.sourceField.secondary = source.secondary;
    this.sourceField.sortContext = source.sortContext;
  }

  get primarySource() { return this.sourceField.source; }
  set primarySource(value: ListPrimarySource) { this.sourceField.source = value; }

  get secondarySource() { return this.sourceField.secondary; }
  set secondarySource(value: string|undefined) { this.sourceField.secondary = value; }

  get sortContext() { return this.sourceField.sortContext; }
  set sortContext(value: SortContext|undefined) { this.sourceField.sortContext = value; }

  private checkDatabaseDirty() {
    const resolvedSource = NanoApp.instance!.resolveSource(this.sourceField);
    if (this.cachedPrimarySource !== resolvedSource.source ||
        this.cachedSecondarySource !== resolvedSource.secondary ||
        this.cachedSortContext !== resolvedSource.sortContext ||
        this.cachedSearchContextEpoch !== this.database.searchContextEpoch ||
        this.cachedListChangeEpoch !== this.database.listChangeEpoch) {
      this.cachedPrimarySource = resolvedSource.source;
      this.cachedSecondarySource = resolvedSource.secondary;
      this.cachedSortContext = resolvedSource.sortContext;
      this.cachedSearchContextEpoch = this.database.searchContextEpoch;
      this.cachedListChangeEpoch = this.database.listChangeEpoch;
      this.databaseDirty = true;
    }
  }

  private boundOnDatabaseTrackPathsUpdated = this.onDatabaseTrackPathsUpdated.bind(this);
  private onDatabaseTrackPathsUpdated(paths: string[]) {
    if (this.tracksDirty) {
      return;
    }
    const pathsSet = new Set<string>(paths);
    for (const [key, block] of this.cachedBlocks.entries()) {
      for (const track of block) {
        if (pathsSet.has(track.path)) {
          this.tracksDirty = true;
          this.onCachedTrackInvalidated();
          return;
        }
      }
    }
  }

  get index() {
    return this.currentIndex;
  }

  get trackCount() {
    return this.cachedTrackCount;
  }

  setAnchor(anchor: TrackPositionAnchor|undefined) {
    this.anchor = anchor;
  }

  seek(index: number) {
    this.currentIndex = index;
  }

  async seekToAnchor() {}

  peekRegion(startDelta: number, endDelta: number, absolute = false): TrackPeekResult {
    this.checkDatabaseDirty();
    const source = NanoApp.instance!.resolveSource(this.sourceField);

    const contextDirty = this.databaseDirty;
    const databaseDirty = this.databaseDirty || this.tracksDirty;
    this.tracksDirty = false;
    this.databaseDirty = false;

    let reanchorFromPos = this.currentIndex;
    const reanchorFromAnchor = this.anchor;
    let reanchoredDelta = 0;
    let currentFromPos = this.currentIndex;
    if (currentFromPos === Infinity || currentFromPos >= this.cachedTrackCount) {
      currentFromPos = this.cachedTrackCount - 1;
    }
    if (currentFromPos < 0) {
      currentFromPos = 0;
    }

    const missingBlocks: number[] = [];
    const invalidatedBlocks: number[] = [];
    const regionBlocks: Array<Track[]|undefined> = [];
    let dirtyResults: TrackUpdatedResults;
    {
      const startIndex = absolute ? startDelta : (currentFromPos + startDelta);
      const endIndex = absolute ? endDelta : (currentFromPos + endDelta);
      const startBlock = Math.max(0, TrackCursor.indexToBlock(startIndex));
      const endBlock = TrackCursor.indexToBlock(endIndex);

      for (let blockNumber = startBlock; blockNumber <= endBlock; ++blockNumber) {
        let cachedBlock = this.cachedBlocks.get(blockNumber);
        if (cachedBlock === undefined) {
          missingBlocks.push(blockNumber);
          cachedBlock = this.invalidatedBlocks.get(blockNumber);
        }
        regionBlocks.push(cachedBlock);
      }

      const dirtyResultsGenerator = this.tracksFromRegionBlocksGenerator(regionBlocks, startBlock, startIndex, endIndex);
      dirtyResults = {
        rebasedStartIndex: startIndex,
        rebasedEndIndex: endIndex,
        results: dirtyResultsGenerator,
        totalCount: this.cachedTrackCount,
      }


      if (databaseDirty) {
        // Move all cachedBlocks to invalidated. They can still be pulled, but
        // they will get cleared after the first fetch.
        for (const [key, value] of this.cachedBlocks.entries()) {
          this.invalidatedBlocks.set(key, value);
          invalidatedBlocks.push(key);
        }
        this.cachedBlocks.clear();
      }
    }

    let trackCountPromise: Promise<number>;
    if (databaseDirty) {
      trackCountPromise = (async () => {
        let updatedTrackCount = await this.database.countTracks(source);
        this.cachedTrackCount = updatedTrackCount;

        // Reanchor.
        if (reanchorFromAnchor) {
          const peekAnchorTracks = await this.database.fetchTracksInRange(source, reanchorFromAnchor.index, reanchorFromAnchor.index);
          if (peekAnchorTracks.at(0)?.path === reanchorFromAnchor.path) {
            // Anchor is valid.
          } else {
            const newIndex = await this.database.findTrackFirstIndex(source, reanchorFromAnchor.path);
            if (!newIndex) {
              this.anchor = undefined;
            } else {
              reanchoredDelta = newIndex - reanchorFromAnchor.index;
              this.anchor = { index: newIndex, path: reanchorFromAnchor.path };
            }
          }
        }

        return updatedTrackCount;
      })();
    } else {
      trackCountPromise = Promise.resolve(this.cachedTrackCount);
    }

    const updateBlocksPromise = missingBlocks.length <= 0 && !databaseDirty ? undefined : trackCountPromise.then(async (updatedTrackCount) => {
      let updatedBlocks = Array.from(regionBlocks);
      let rebasedDelta: number|undefined = undefined;
      if (databaseDirty) {
        updatedBlocks = new Array<Track[]|undefined>(updatedBlocks.length);

        const useOldAnchor = Number.isFinite(reanchorFromPos);
        if (reanchorFromPos === Infinity || reanchorFromPos >= this.cachedTrackCount) {
          reanchorFromPos = this.cachedTrackCount - 1;
        }
        if (reanchorFromPos < 0) {
          reanchorFromPos = 0;
        }
        if (useOldAnchor) {
          reanchorFromPos = Math.max(0, Math.min(this.cachedTrackCount - 1, reanchorFromPos + reanchoredDelta));
          rebasedDelta = reanchoredDelta;
        }
        this.currentIndex = reanchorFromPos;
      }

      const startIndex = absolute ? startDelta : (reanchorFromPos + startDelta);
      const endIndex = absolute ? endDelta : (reanchorFromPos + endDelta);
      const startBlock = Math.max(0, TrackCursor.indexToBlock(startIndex));
      const endBlock = TrackCursor.indexToBlock(endIndex);

      const fetchPromises = [];
      let blockIndex = 0;
      for (let blockToFetch = startBlock; blockToFetch <= endBlock; ++blockToFetch) {
        const blockToFetchCapture = blockToFetch;
        let fetch = this.fetchesInFlight.get(blockToFetch);
        if (fetch === undefined) {
          fetch = (async () => {
            const fetchedBlock =
                await this.database.fetchTracksInRange(
                    source,
                    TrackCursor.blockStartIndex(blockToFetchCapture),
                    TrackCursor.blockEndIndex(blockToFetchCapture));
            this.cachedBlocks.put(blockToFetchCapture, fetchedBlock);
            return fetchedBlock;
          })();
          this.fetchesInFlight.set(blockToFetch, fetch);
          fetch.then(() => {
            this.fetchesInFlight.delete(blockToFetch);
          });
        }
        const storeIndex = blockIndex++;
        fetch.then(fetched => {
          updatedBlocks[storeIndex] = fetched;
        });
        fetchPromises.push(fetch);
      }
      await Promise.all(fetchPromises);
      const generator = this.tracksFromRegionBlocksGenerator(updatedBlocks, startBlock, startIndex, endIndex);

      for (const key of invalidatedBlocks) {
        this.invalidatedBlocks.delete(key);
      }

      return utils.upcast<TrackUpdatedResults>({
        rebasedStartIndex: startIndex,
        rebasedEndIndex: endIndex,
        rebasedDelta: rebasedDelta,
        results: generator,
        totalCount: updatedTrackCount,
      });
    });

    return {
      contextChanged: contextDirty,
      dirtyResults: dirtyResults,
      updatedResultsPromise: updateBlocksPromise,
    };
  }

  private* tracksFromRegionBlocksGenerator(regionBlocks: Array<Track[]|undefined>, startBlock: number, startIndex: number, endIndex: number): Iterable<Track|undefined> {
    for (let index = startIndex; index <= endIndex; ++index) {
      let regionBlockIndex = TrackCursor.indexToBlock(index);
      let relativeBlockIndex = regionBlockIndex - startBlock;
      let regionStartIndex = TrackCursor.blockStartIndex(regionBlockIndex);
      const indexInRegionBlock = index - regionStartIndex;
      yield regionBlocks.at(relativeBlockIndex)?.at(indexInRegionBlock);
    }
  }

  private static indexToBlock(index: number) {
    return Math.floor(index / TrackCursor.blockSize);
  }

  private static blockStartIndex(blockNumber: number) {
    return blockNumber * TrackCursor.blockSize;
  }

  private static blockEndIndex(blockNumber: number) {
    return blockNumber * TrackCursor.blockSize + TrackCursor.blockSize - 1;
  }
}
