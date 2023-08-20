import { ListPrimarySource, Database, SortContext } from "./database";
import { Track } from "./schema";
import * as utils from './utils';
import * as constants from './constants';

export interface TrackPositionAnchor {
  index?: number;
  indexRangeMin?: number;
  indexRangeMax?: number;
  path?: string;
  pathRangeMin?: string;
  pathRangeMax?: string;
}

export interface TrackUpdatedResults {
  results: Iterable<Track>;
  count?: number;
}

export interface TrackPeekResult {
  dirtyResults: Iterable<Track>;
  updatedResultsPromise: Promise<TrackUpdatedResults>|undefined;
}

export class TrackCursor {
  private static readonly cachedBlockCount = 64;
  private static readonly blockSize = 128;

  private databaseDirty = true;
  private currentIndex = 0;
  private cachedTrackCount = 0;

  private readonly cachedBlocks = new utils.LruCache<number, Track[]>(TrackCursor.cachedBlockCount);
  private readonly fetchesInFlight = new Map<number, Promise<Track[]>>();

  private cachedPrimarySource: ListPrimarySource;
  private cachedSortContext: SortContext;
  private cachedSearchContextEpoch: number;
  private cachedListChangeEpoch: number;

  constructor(
      public readonly database: Database,
      public primarySource: ListPrimarySource,
      public sortContext: SortContext,
      public anchor: TrackPositionAnchor) {
    this.cachedPrimarySource = this.database.resolvePrimarySource(this.primarySource);
    this.cachedSortContext = sortContext;
    this.cachedSearchContextEpoch = this.database.searchContextEpoch;
    this.cachedListChangeEpoch = this.database.listChangeEpoch;
  }

  dispose() {
  }

  private checkDatabaseDirty() {
    const resolvedPrimarySource = this.database.resolvePrimarySource(this.primarySource);
    if (this.cachedPrimarySource !== resolvedPrimarySource ||
        this.cachedSortContext !== this.sortContext ||
        this.cachedSearchContextEpoch !== this.database.searchContextEpoch ||
        this.cachedListChangeEpoch !== this.database.listChangeEpoch) {
      this.cachedPrimarySource = resolvedPrimarySource;
      this.cachedSortContext = this.sortContext;
      this.cachedSearchContextEpoch = this.database.searchContextEpoch;
      this.cachedListChangeEpoch = this.database.listChangeEpoch;
      this.databaseDirty = true;
    }
  }

  get index() {
    return this.currentIndex;
  }

  get trackCount() {
    return this.cachedTrackCount;
  }

  setAnchor(anchor: TrackPositionAnchor) {
    this.anchor = anchor;
  }

  seek(index: number) {
    this.currentIndex = index;
  }

  async seekToAnchor() {}

  peekRegion(startDelta: number, endDelta: number): TrackPeekResult {
    this.checkDatabaseDirty();

    const databaseDirty = this.databaseDirty;
    this.databaseDirty = false;

    let reanchorFromPos = this.currentIndex;
    let currentFromPos = this.currentIndex;
    if (currentFromPos === Infinity || currentFromPos >= this.cachedTrackCount) {
      currentFromPos = this.cachedTrackCount - 1;
    }
    if (currentFromPos < 0) {
      currentFromPos = 0;
    }

    const missingBlocks: number[] = [];
    const regionBlocks: Array<Track[]|undefined> = [];
    let dirtyResultsGenerator;
    {
      const startIndex = currentFromPos + startDelta;
      const endIndex = currentFromPos + endDelta;
      const startBlock = Math.max(0, TrackCursor.indexToBlock(startIndex));
      const endBlock = TrackCursor.indexToBlock(endIndex);

      for (let blockNumber = startBlock; blockNumber <= endBlock; ++blockNumber) {
        const cachedBlock = this.cachedBlocks.get(blockNumber);
        if (cachedBlock === undefined) {
          missingBlocks.push(blockNumber);
        }
        regionBlocks.push(cachedBlock);
      }

      dirtyResultsGenerator = this.tracksFromRegionBlocksGenerator(regionBlocks, startBlock, startIndex, endIndex);

      if (databaseDirty) {
        // TODO: Handle this.databaseDirty better.
        this.cachedBlocks.clear();
      }
    }

    let trackCountPromise: Promise<number|undefined>;
    if (databaseDirty) {
      trackCountPromise = (async () => {
        let updatedTrackCount = await this.database.countTracks({ source: 'auto', sortContext: this.sortContext });
        this.cachedTrackCount = updatedTrackCount;
        return updatedTrackCount;
      })();
    } else {
      trackCountPromise = Promise.resolve(undefined);
    }

    const updateBlocksPromise = missingBlocks.length <= 0 && !databaseDirty ? undefined : trackCountPromise.then(async (updatedTrackCount) => {
      let updatedBlocks = Array.from(regionBlocks);
      if (databaseDirty) {
        // TODO: Handle this.databaseDirty better.
        updatedBlocks = new Array<Track[]|undefined>(updatedBlocks.length);

        if (reanchorFromPos === Infinity || reanchorFromPos >= this.cachedTrackCount) {
          reanchorFromPos = this.cachedTrackCount - 1;
        }
        if (reanchorFromPos < 0) {
          reanchorFromPos = 0;
        }
        this.currentIndex = reanchorFromPos;
      }

      const startIndex = reanchorFromPos + startDelta;
      const endIndex = reanchorFromPos + endDelta;
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
                    { source: 'auto', sortContext: this.sortContext },
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

      return {
        results: generator,
        count: updatedTrackCount,
      };
    });

    return {
      dirtyResults: dirtyResultsGenerator,
      updatedResultsPromise: updateBlocksPromise,
    };
  }

  private* tracksFromRegionBlocksGenerator(regionBlocks: Array<Track[]|undefined>, startBlock: number, startIndex: number, endIndex: number): Iterable<Track> {
    if (regionBlocks.length <= 0) {
      return;
    }
    let regionBlockIndex = 0;
    let regionStartIndex = TrackCursor.blockStartIndex(startBlock + regionBlockIndex);
    let regionEndIndex = TrackCursor.blockEndIndex(startBlock + regionBlockIndex);
    let regionBlock = regionBlocks[regionBlockIndex];
    if (regionBlock === undefined) {
      return;
    }
    for (let index = startIndex; index <= endIndex; ++index) {
      while (true) {
        if (index <= regionEndIndex) {
          break;
        }
        regionBlockIndex++;
        if (regionBlockIndex >= regionBlocks.length) {
          return;
        }
        regionStartIndex = TrackCursor.blockStartIndex(startBlock + regionBlockIndex);
        regionEndIndex = TrackCursor.blockEndIndex(startBlock + regionBlockIndex);
        regionBlock = regionBlocks[regionBlockIndex];
        if (regionBlock === undefined) {
          return;
        }
      }
      const indexInRegionBlock = index - regionStartIndex;
      if (indexInRegionBlock < 0) {
        continue;
      }
      if (indexInRegionBlock >= regionBlock.length) {
        return;
      }
      yield regionBlock[indexInRegionBlock];
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