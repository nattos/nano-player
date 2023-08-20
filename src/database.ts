import { IDBPDatabase, IDBPObjectStore, IDBPTransaction, deleteDB, openDB } from "idb";
import { observable, makeObservable, action } from "mobx";
import { LibraryPathEntry, Track, TrackPrefix, SearchTableEntry } from "./schema";
import { TrackPositionAnchor, TrackCursor } from "./track-cursor";
import * as utils from './utils';
import * as constants from './constants';

export type ListPrimarySource = 'auto'|'library'|'search'|'playlist';

export interface ListSource {
  source: ListPrimarySource;
  secondary?: string;
  sortContext?: SortContext;
}

class Canceled {}

type SearchTableName = 'search-table-a'|'search-table-b';
export type SearchResultStatus = 'no_query'|'partial'|'ready';
export type QueryTokenContext = 'all'|'title'|'artist'|'album'|'genre'|'index';
export type SortContext = 'title'|'artist'|'album'|'genre'|'index';
export type UpdateMode = 'create_only'|'upsert'|'update_only';

const ALL_QUERY_TOKEN_CONTEXTS: QueryTokenContext[] = ['all','title','artist','album','genre','index'];
const ALL_SORT_CONTEXTS: SortContext[] = ['title','artist','album','genre','index'];
const SORT_CONTEXTS_TO_METADATA_PATH = {
  'title': 'metadata.title',
  'artist': 'metadata.artist',
  'album': 'metadata.album',
  'genre': 'metadata.genre',
  'index': 'generatedMetadata.librarySortKey',
};

export class Database {
  public static get instance() {
    if (!Database.instanceField) {
      Database.instanceField = new Database();
    }
    return Database.instanceField;
  }
  private static instanceField?: Database;

  private readonly database: Promise<IDBPDatabase>;
  private readonly updateTrackTables: string[];

  private nextSearchQuery = '';
  private nextSearchQueryDirty = false;
  private searchQueryUpdateInFlight = Promise.resolve();
  private searchQueryUpdateCancel = new utils.Resolvable<void>();

  private currentSearchTable: SearchTableName = 'search-table-a';
  private partialSearchTable: SearchTableName = 'search-table-b';

  private libraryPaths: LibraryPathEntry[] = [];
  private readonly libraryPathsMap = new Map<string, LibraryPathEntry>();
  private syncLibraryPathsFlow = Promise.resolve();

  @observable searchResultsStatus: SearchResultStatus = 'no_query';
  @observable partialSearchResultsAvailable = 0;
  @observable partialSearchResultsSummary: Track[] = [];
  @observable searchContextEpoch = 0;
  @observable listChangeEpoch = 0;

  constructor() {
    makeObservable(this);
    this.updateTrackTables =
        ['all-tracks'].concat(
          Array.from(utils.mapAll(ALL_QUERY_TOKEN_CONTEXTS,
                (context) => constants.INDEXED_PREFIX_LENGTHS.map(
                  prefixLength => Database.getPrefixIndexName(context, prefixLength)))));
    this.database = this.openDatabaseAsync();
  }

  findLibraryPath(sourceKey: string): LibraryPathEntry|undefined {
    return this.libraryPathsMap.get(sourceKey);
  }

  getLibraryPaths(): LibraryPathEntry[] {
    return this.libraryPaths;
  }

  async addLibraryPath(directoryHandle: FileSystemDirectoryHandle) {
    await this.database;

    // Remove duplicate. Allow subdirectories, because it's possible to add a parent afterwards.
    for (const existingPath of this.libraryPaths) {
      const resolvedPaths = await existingPath.directoryHandle?.resolve(directoryHandle);
      if (resolvedPaths?.length === 0) {
        return;
      }
    }
    const newPath = crypto.randomUUID();
    const newEntry: LibraryPathEntry = {
      path: newPath,
      directoryHandle: directoryHandle,
    };
    this.libraryPaths.push(newEntry);
    this.libraryPathsMap.set(newEntry.path, newEntry);

    this.syncLibraryPathsFlow = this.syncLibraryPathsFlow.then(async () => {
      const db = await this.database;
      const tx = db.transaction('library-paths', 'readwrite');
      const libraryPathsTable = tx.objectStore('library-paths');
      libraryPathsTable.put(newEntry);
    });
  }

  cursor(primarySource: ListPrimarySource, sortContext: SortContext, anchor: TrackPositionAnchor) {
    return new TrackCursor(this, primarySource, sortContext, anchor);
  }

  async fetchTracksInRange(source: ListSource, min: number, max: number): Promise<Track[]> {
    const db = await this.database;
    const sortIndex = this.getSourceIndexlike(source, db);

    const cursor = await sortIndex.openCursor();
    if (!cursor) {
      return [];
    }
    min = Math.max(0, min);
    if (min > 0 && await cursor.advance(min) === null) {
      return [];
    }
    const results: Track[] = [];
    const readLength = max - min;
    for (let i = 0; i < readLength; ++i) {
      results.push(cursor.value);
      if (!await cursor.advance(1)) {
        break;
      }
    }
    return results;
  }

  async countTracks(source: ListSource): Promise<number> {
    const db = await this.database;
    const sortIndex = this.getSourceIndexlike(source, db);
    // const allTracksTable = tx.objectStore('all-tracks');
    // const sortIndex = allTracksTable.index(sortContext);
    return await sortIndex.count();
  }

  async fetchTrackByPath(path: string): Promise<Track|undefined> {
    const db = await this.database;
    const tx = db.transaction('all-tracks', 'readonly');
    const allTracksTable = tx.objectStore('all-tracks');
    const track = await allTracksTable.get(path);
    return track;
  }

  resolvePrimarySource(source: ListPrimarySource): ListPrimarySource {
    const searchStatus = this.searchResultsStatus;
    return source === 'auto'
        ? (searchStatus === 'no_query' ? 'library' : 'search')
        : source;
  }

  private getSourceIndexlike(source: ListSource, db: IDBPDatabase) {
    return this.getSourceIndex(this.getSourceInnerIndexlike(source, db), source.sortContext);
  }

  private getSourceInnerIndexlike(source: ListSource, db: IDBPDatabase) {
    const searchStatus = this.searchResultsStatus;
    const primarySource = this.resolvePrimarySource(source.source);
    function getTable(name: string) {
      return db.transaction(name, 'readonly').objectStore(name);
    }

    switch (primarySource) {
      default:
      case 'library':
        return getTable('all-tracks');
      case 'search':
        switch (searchStatus) {
          default:
          case 'no_query':
            // TODO: Return empty.
            return getTable(this.currentSearchTable);
          case 'partial':
            // TODO: Handle summary.
            return getTable(this.partialSearchTable);
          case 'ready':
            return getTable(this.currentSearchTable);
        }
        break;
      // case 'playlist':
    }
  }

  private getSourceIndex(store: IDBPObjectStore<unknown, ArrayLike<string>, any, 'readonly'>, sortContext?: SortContext) {
    return store.index(sortContext ?? 'index');
  }

  @action
  private setSearchResultStatus(status: SearchResultStatus, partialCount: number, partialResultsSummary: Track[] = []) {
    this.searchResultsStatus = status;
    this.partialSearchResultsAvailable = partialCount;
    this.partialSearchResultsSummary = partialResultsSummary;
    this.searchContextEpoch++;
  }

  public async updateTracks(tracks: Track[], mode: UpdateMode): Promise<string[]> {
    const db = await this.database;
    const tx = db.transaction(this.updateTrackTables, 'readwrite');

    const updatedPaths: string[] = [];
    let aborted = true;
    try {
      for (const track of tracks) {
        if (await this.addTrackInTransaction(track, tx, mode)) {
          updatedPaths.push(track.path);
          aborted = false;
        }
      }
    } catch {
      aborted = true;
      tx.abort();
    } finally {
      if (!aborted) {
        tx.commit();
        await tx.done;
        this.listChangeEpoch++;
      }
    }
    console.log(`Updated tracks in database: ${updatedPaths}`);
    return updatedPaths;
  }

  private async addTrackInTransaction(track: Track, tx: IDBPTransaction<unknown, string[], "readwrite">, mode: UpdateMode): Promise<boolean> {
    const path = track.path;
    if (!path) {
      return false;
    }

    const allTracks = tx.objectStore('all-tracks');
    async function trackExists() {
      return await allTracks.get(path) !== undefined;
    }
    switch (mode) {
      default:
      case 'upsert':
        break;
      case 'create_only':
        if (await trackExists()) {
          return false;
        }
        break;
      case 'update_only':
        if (!await trackExists()) {
          return false;
        }
        break;
    }
    allTracks.put(track);

    for (const prefixLength of constants.INDEXED_PREFIX_LENGTHS) {
      function insertForContext(context: QueryTokenContext, prefixArrays: Array<Array<string>>) {
        const prefixesSet = new Set<string>();
        for (const prefixArray of prefixArrays) {
          utils.setAddRange(prefixesSet, prefixArray);
        }
        const prefixes = Array.from(prefixesSet).sort();
        const prefixTable = tx.objectStore(Database.getPrefixIndexName(context, prefixLength));
        const prefixEntry: TrackPrefix = {
          path: path,
          prefixes: prefixes,
        };
        prefixTable.put(prefixEntry);
      }
      function generatePrefixes(str: string|undefined) {
        return Array.from(Database.generatePrefixes(str, prefixLength));
      }

      const pathPrefixes = generatePrefixes(Database.getPathFilePath(track.path));
      const titlePrefixes = generatePrefixes(track.metadata?.title);
      const artistPrefixes = generatePrefixes(track.metadata?.artist);
      const albumPrefixes = generatePrefixes(track.metadata?.album);
      const genrePrefixes = generatePrefixes(track.metadata?.genre);
      const indexPrefixes = generatePrefixes(track.generatedMetadata?.librarySortKey);

      type QueryTokenContext = 'all'|'title'|'artist'|'album'|'genre'|'index';
      insertForContext('all', [ pathPrefixes, titlePrefixes, artistPrefixes, albumPrefixes, genrePrefixes, indexPrefixes ]);
      insertForContext('title', [ titlePrefixes ]);
      insertForContext('artist', [ artistPrefixes ]);
      insertForContext('album', [ albumPrefixes ]);
      insertForContext('genre', [ genrePrefixes ]);
      insertForContext('index', [ indexPrefixes ]);
    }
    return true;
  }

  setSearchQuery(query: string) {
    this.nextSearchQuery = query;
    this.nextSearchQueryDirty = true;
    this.searchQueryUpdateCancel.resolve();
    (async () => {
      await this.searchQueryUpdateInFlight;
      if (!this.nextSearchQueryDirty) {
        return;
      }
      this.nextSearchQueryDirty = false;

      const cancelFlag = new utils.Resolvable<void>();
      this.searchQueryUpdateCancel = cancelFlag;
      this.searchQueryUpdateInFlight = this.updateSearchTable(this.tokenizeQuery(this.nextSearchQuery), cancelFlag);
    })();
  }

  private tokenizeQuery(query: string): string[] {
    return query.split(/\s/).map(token => token.trim().toLocaleLowerCase()).filter(token => token.length > 0);
  }

  private async updateSearchTable(queryTokens: string[], cancelFlag: utils.Resolvable<void>) {
    try {
      return await this.updateSearchTableInner(queryTokens, cancelFlag);
    } catch (e) {
      if (e === Canceled) {
        console.log("updateSearchTable canceled");
        return;
      }
      this.setSearchResultStatus('no_query', 0);
      throw e;
    }
  }

  private async updateSearchTableInner(queryTokens: string[], cancelFlag: utils.Resolvable<void>) {
    const searchTableName = Database.getNextSearchTable(this.currentSearchTable);

    const canceledPromise = cancelFlag.promise.then(() => Canceled);
    async function orThrowCanceled<T>(promise?: Promise<T>) {
      if (promise === undefined) {
        return undefined as T;
      }
      const result = await Promise.race([promise, canceledPromise]);
      if (result === Canceled) {
        throw Canceled;
      }
      return result as T;
    }

    const db = await orThrowCanceled(this.database);
    const tx = db.transaction(this.updateTrackTables, 'readonly');
    const allTracksTable = tx.objectStore('all-tracks');

    const minPrefixLength = constants.INDEXED_PREFIX_LENGTHS[0];
    const maxPrefixLength = constants.INDEXED_PREFIX_LENGTHS[constants.INDEXED_PREFIX_LENGTHS.length - 1];

    let hasBest = false;
    let bestCount = 0;
    let bestCursorFunc = undefined;
    for (const queryToken of queryTokens) {
      if (queryToken.length < minPrefixLength) {
        continue;
      }
      let prefixLength = Math.min(maxPrefixLength, queryToken.length);
      if (!constants.INDEXED_PREFIX_LENGTHS.includes(prefixLength)) {
        prefixLength = constants.INDEXED_PREFIX_LENGTHS.reduce((a, b) => b >= prefixLength ? a : b > a ? b : a, minPrefixLength);
      }

      const queryPrefix = queryToken.slice(0, prefixLength);

      const prefixTableName = Database.getPrefixIndexName('all', prefixLength);
      const prefixTable = tx.objectStore(prefixTableName);
      const prefixesIndex = prefixTable.index('prefixes');
      const foundCount = await orThrowCanceled(prefixesIndex.count(IDBKeyRange.only(queryPrefix)));

      if (!hasBest || foundCount < bestCount) {
        hasBest = true;
        bestCount = foundCount;
        bestCursorFunc = () => prefixesIndex.openKeyCursor(IDBKeyRange.only(queryPrefix));
      }
    }

    async function withSearchTable(func: (searchTable: IDBPObjectStore<unknown, SearchTableName[], SearchTableName, "readwrite">) => Promise<void>) {
      const searchTableTx = db.transaction([searchTableName], 'readwrite');
      const searchTable = searchTableTx.objectStore(searchTableName);
      await func(searchTable);
      await searchTableTx;
    }

    const searchTableAddFlow = new utils.BatchedProducerConsumerFlow<Track>(constants.UPDATE_BATCH_SIZE);
    try {
      let findCount = 0;
      const partialSummary: Track[] = [];

      searchTableAddFlow.consume((toAdd) => withSearchTable(async (searchTable) => {
        for (const toAddTrack of toAdd) {
          const toAddEntry: SearchTableEntry = toAddTrack;
          searchTable.put(toAddEntry);
        }
        this.setSearchResultStatus('partial', findCount, partialSummary);
      }));

      searchTableAddFlow.consumerThen(() => withSearchTable(async (searchTable) => {
        await searchTable.delete(IDBKeyRange.lowerBound(''));
      }));

      function pushToAdd(track: Track) {
        if (partialSummary.length < constants.PARTIAL_SUMMARY_LENGTH) {
          partialSummary.push(track);
        }
        searchTableAddFlow.produce(track);
      }

      let didPublishPartial = false;

      const cursor = await orThrowCanceled(bestCursorFunc?.());
      if (cursor) {
        while (true) {
          const track = await orThrowCanceled(allTracksTable.get(cursor.primaryKey)) as Track;
          if (this.queryMatchesTrack(queryTokens, track)) {
            pushToAdd(track);
            ++findCount;
          }
          if (!didPublishPartial && findCount >= constants.PARTIAL_SEARCH_BATCH_SIZE) {
            didPublishPartial = true;
            searchTableAddFlow.flushProduced();
            this.partialSearchTable = searchTableName;
          }
          if (!await orThrowCanceled(cursor.advance(1))) {
            break;
          }
        }
      }

      await orThrowCanceled(searchTableAddFlow.join());
      this.currentSearchTable = searchTableName;
      this.setSearchResultStatus(queryTokens.length === 0 ? 'no_query' : 'ready', findCount);
      console.log(`Scanned ${bestCount} entries to find ${findCount} results.`);
    } catch (e) {
      if (e === Canceled) {
        await searchTableAddFlow.join(true);
      }
      throw e;
    }
  }

  private queryMatchesTrack(queryTokens: string[], track: Track) {
    const path = Database.getPathFilePath(track.path).toLocaleLowerCase();
    return queryTokens.every(token =>
        path.includes(token) ||
        track.metadata?.title?.toLocaleLowerCase()?.includes(token) ||
        track.metadata?.artist?.toLocaleLowerCase()?.includes(token) ||
        track.metadata?.album?.toLocaleLowerCase()?.includes(token) ||
        track.metadata?.genre?.toLocaleLowerCase()?.includes(token) ||
        false
    );
  }

  private async openDatabaseAsync() {
    if (constants.DEBUG_RESET_DATABASE) {
      await deleteDB('data-tables');
    }
    const db = await openDB('data-tables', 1, {
      upgrade: (upgradeDb) => {
      if (!upgradeDb.objectStoreNames.contains('all-tracks')) {
        const allTracksTable = upgradeDb.createObjectStore('all-tracks', { keyPath: 'path' });
        for (const context of ALL_QUERY_TOKEN_CONTEXTS) {
          for (const prefixLength of constants.INDEXED_PREFIX_LENGTHS) {
            const prefixTableName = Database.getPrefixIndexName(context, prefixLength);
            const prefixTable = upgradeDb.createObjectStore(prefixTableName, { keyPath: 'path' });
            prefixTable.createIndex('prefixes', 'prefixes', { unique: false, multiEntry: true });
          }
        }
        const searchTableA = upgradeDb.createObjectStore('search-table-a', { keyPath: 'path' });
        const searchTableB = upgradeDb.createObjectStore('search-table-b', { keyPath: 'path' });
        upgradeDb.createObjectStore('library-paths', { keyPath: 'path' });

        const allSortableTables = [allTracksTable, searchTableA, searchTableB];
        for (const table of allSortableTables) {
          for (const context of ALL_SORT_CONTEXTS) {
            const keyPath = SORT_CONTEXTS_TO_METADATA_PATH[context];
            table.createIndex(context, keyPath, { unique: false });
          }
        }
      }
      console.log(upgradeDb);
    }})

    this.syncLibraryPathsFlow = this.syncLibraryPathsFlow.then(async () => {
      const tx = db.transaction('library-paths', 'readonly');
      const libraryPathsTable = tx.objectStore('library-paths');
      this.libraryPaths = await libraryPathsTable.getAll() as LibraryPathEntry[];
      this.libraryPathsMap.clear();
      for (const entry of this.libraryPaths) {
        this.libraryPathsMap.set(entry.path, entry);
      }
      await tx;
    });

    if (constants.DEBUG_RESET_DATABASE && constants.DEBUG_INSERT_FAKE_DATA) {
      function makeFakeTrack(path: string): Track {
        return {
          path: path,
          addedDate: Date.now(),
          indexedDate: 0,
          indexedAtLastModifiedDate: 0,
        };
      }

      this.database.then(async () => {
        const tokens = [
          'Abjure',
          'Future',
          'Picnic',
          'Campus',
          'Invest',
          'Ship',
          'Catfish',
          'Jackpot',
          'Significance',
          'Carsick',
          'Kitchenette',
          'Sometimes',
          'Celebrate',
          'Law',
          'Sublime',
        ];

        const toAdd: Track[] = [];

        for (let i = 0; i < 10000; ++i) {
          const tokenCount = Math.max(1, Math.round(Math.random() * 7));
          let result = '';
          for (let j = 0; j < tokenCount; ++j) {
            const token = tokens[Math.round(Math.random() * tokens.length) % tokens.length];
            if (j !== 0 && Math.random() < 0.5) {
              result += ' ';
            }
            result += token;
          }
          toAdd.push(makeFakeTrack(result));
        }
        toAdd.push(makeFakeTrack("somePath"));
        toAdd.push(makeFakeTrack("someOtherPath"));
        toAdd.push(makeFakeTrack("わからん"));
        toAdd.push(makeFakeTrack("わからなさ"));
        toAdd.push(makeFakeTrack("からなー"));
        toAdd.push(makeFakeTrack("totallyAwkward"));

        await this.updateTracks(toAdd, 'upsert');
        await this.setSearchQuery("からな　ー");
        console.log("done add");
      });
    }

    return db;
  }

  static getPathSourceKey(path: string) {
    const [sourceKey, filePath] = Database.getPathParts(path);
    return sourceKey;
  }

  static getPathFilePath(path: string) {
    const [sourceKey, filePath] = Database.getPathParts(path);
    return filePath;
  }

  public static makePath(sourceKey: string, filePathParts: string[]) {
    return sourceKey + '|' + filePathParts.join('/');
  }

  private static getPathParts(path: string): [sourceKey: string, filePath: string] {
    const splitIndex = path.indexOf('|');
    if (splitIndex < 0) {
      return ['', path];
    }
    const sourceKey = path.slice(0, splitIndex);
    const filePath = path.slice(splitIndex + 1);
    return [sourceKey, filePath];
  }

  private static getPrefixIndexName(context: QueryTokenContext, length: number) {
    return `${context}-prefix${length}`;
  }

  private static getNextSearchTable(from: SearchTableName): SearchTableName {
    switch (from) {
      default:
      case 'search-table-a':
        return 'search-table-b';
      case 'search-table-b':
        return 'search-table-a';
    }
  }

  private static* generatePrefixes(str: string|undefined, prefixLength: number): Iterable<string> {
    if (!str) {
      return;
    }
    str = str.trim().toLocaleLowerCase().replace(/\s/, '');
    const strLen = str.length;
    const prefixCount = strLen - prefixLength + 1;
    for (let i = 0; i < prefixCount; ++i) {
      const prefix = str.slice(i, i + prefixLength);
      yield prefix;
    }
  }
}
