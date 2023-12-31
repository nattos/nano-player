import { IDBPDatabase, IDBPObjectStore, IDBPTransaction, deleteDB, openDB } from "idb";
import { observable, makeObservable, action, runInAction, observe } from "mobx";
import { LibraryPathEntry, Track, TrackPrefix, SearchTableEntry, PlaylistEntry, Preferences, UserPreferences, PreferencesKey, PlayerPreferences, SortContext } from "./schema";
import { TrackPositionAnchor, TrackCursor } from "./track-cursor";
import * as utils from '../utils';
import * as constants from './constants';
import * as environment from './environment';
import { PathsDirectoryHandle, PathsHandle, deserializePathsHandle, makeRootDirectoryHandle } from "./paths";

export interface ResolvedSubpathInLibraryPath {
  handle: PathsHandle;
  libraryPath?: LibraryPathEntry;
  subpath?: string[];
}

export enum ListPrimarySource {
  Auto = 'auto',
  Library = 'library',
  Search = 'search',
  Playlist = 'playlist',
}

export interface ListSource {
  source: ListPrimarySource;
  secondary?: string;
  sortContext?: SortContext;
}

export enum QueryTokenAtom {
  Title = 'title',
  Artist = 'artist',
  Album = 'album',
  Genre = 'genre',
  Path = 'path',
}

export interface QueryToken {
  text: string;
  atom?: QueryTokenAtom;
}

export type TrackUpdaterFunc = (trackGetter: (path: string) => Track|undefined) => PromiseLike<void>|void;

class Canceled {}

enum TableNames {
  AllTracks = 'all-tracks',
  LibraryPaths = 'library-paths',
  Playlists = 'playlists',
  Preferences = 'preferences',
}

enum SearchTableName {
  A = 'search-table-a',
  B = 'search-table-b',
}

enum IndexNames {
  Prefixes = 'prefixes',
  Playlists = 'playlists',
}

export enum SearchResultStatus {
  NoQuery = 'no_query',
  Partial = 'partial',
  Ready = 'ready',
}

export enum QueryTokenContext {
  All = 'all',
  Title = 'title',
  Artist = 'artist',
  Album = 'album',
  Genre = 'genre',
  Index = 'index',
}

export enum UpdateMode {
  CreateOnly = 'create_only',
  Upsert = 'upsert',
  UpdateOnly = 'update_only',
}

enum UpdateStatus {
  Inserted,
  Updated,
}

const ALL_QUERY_TOKEN_CONTEXTS: QueryTokenContext[] = utils.getEnumValues(QueryTokenContext);
const ALL_SORT_CONTEXTS: SortContext[] = utils.getEnumValues(SortContext);
const SORT_CONTEXTS_TO_METADATA_PATH = new Map<SortContext, string[]>([
  [SortContext.Title, ['metadata', 'title']],
  [SortContext.Artist, ['metadata', 'artist']],
  [SortContext.Album, ['metadata', 'album']],
  [SortContext.Genre, ['metadata', 'genre']],
  [SortContext.Index, ['generatedMetadata', 'librarySortKey']],
]);
const ROOT_SOURCE_KEY = '$';

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

  private nextSearchQuery: QueryToken[] = [];
  private nextSearchQueryDirty = false;
  private searchQueryUpdateInFlight = Promise.resolve();
  private searchQueryUpdateCancel = new utils.Resolvable<void>();

  private currentSearchTable: SearchTableName = SearchTableName.A;
  private partialSearchTable: SearchTableName = SearchTableName.B;

  private libraryPaths: LibraryPathEntry[] = [];
  private readonly libraryPathsMap = new Map<string, LibraryPathEntry>();
  private readonly libraryPathsLoaded = new utils.Resolvable<void>();
  private readonly syncLibraryPathsQueue = new utils.OperationQueue();

  private playlists: PlaylistEntry[] = [];
  private readonly playlistsMap = new Map<string, PlaylistEntry>();
  private readonly playlistsLoaded = new utils.Resolvable<void>();
  private readonly syncPlaylistsQueue = new utils.OperationQueue();

  private readonly trackUpdaterQueue = new utils.OperationQueue();

  @observable searchResultsStatus: SearchResultStatus = SearchResultStatus.NoQuery;
  @observable partialSearchResultsAvailable = 0;
  @observable.shallow partialSearchResultsSummary: Track[] = [];
  @observable searchContextEpoch = 0;
  @observable listChangeEpoch = 0;
  @observable trackDataChangeEpoch = 0;

  readonly onTrackPathsUpdated = utils.multicast<(paths: string[]) => void>();

  constructor() {
    makeObservable(this);
    this.updateTrackTables =
        utils.upcast<string[]>([TableNames.AllTracks]).concat(
          Array.from(utils.mapAll(ALL_QUERY_TOKEN_CONTEXTS,
                (context) => constants.INDEXED_PREFIX_LENGTHS.map(
                  prefixLength => Database.getPrefixIndexName(context, prefixLength)))));
    this.database = this.openDatabaseAsync();
  }

  async waitForLoad() {
    await this.database;
    await this.userPreferencesSyncer.waitForLoad();
  }

  async getRawDatabase() {
    return await this.database;
  }

  private playerPreferencesSyncer = new ObservablePreferences(this, () => utils.upcast<PlayerPreferences>({
    key: PreferencesKey.Player,
    lastPlayedLocation: {
      playlistKey: null,
      sortContext: null,
      index: null,
    },
  }));
  get playerPreferences(): PlayerPreferences {
    return this.playerPreferencesSyncer.asObservable;
  }

  private userPreferencesSyncer = new ObservablePreferences(this, () => utils.upcast<UserPreferences>({
    key: PreferencesKey.User,
  }));
  get userPreferences(): UserPreferences {
    return this.userPreferencesSyncer.asObservable;
  }

  findLibraryPath(sourceKey: string): LibraryPathEntry|undefined {
    return this.libraryPathsMap.get(sourceKey);
  }

  getLibraryPaths(): LibraryPathEntry[] {
    return this.libraryPaths;
  }

  async addLibraryPath(directoryHandle: PathsDirectoryHandle): Promise<LibraryPathEntry> {
    await this.database;

    // Remove duplicate. Allow subdirectories, because it's possible to add a parent afterwards.
    for (const existingPath of this.libraryPaths) {
      const resolvedPaths = await existingPath.directoryHandle?.resolve(directoryHandle);
      if (resolvedPaths?.length === 0) {
        return existingPath;
      }
    }
    const newPath = crypto.randomUUID();
    const newEntry: LibraryPathEntry = {
      path: newPath,
      directoryHandle: directoryHandle,
      indexedSubpaths: [],
    };
    this.libraryPaths.push(newEntry);
    this.libraryPathsMap.set(newEntry.path, newEntry);

    this.syncLibraryPathsQueue.push(async () => {
      const db = await this.database;
      const tx = db.transaction(TableNames.LibraryPaths, 'readwrite');
      const libraryPathsTable = tx.objectStore(TableNames.LibraryPaths);
      libraryPathsTable.put(newEntry);
    });
    return newEntry;
  }

  async setLibraryPathIndexedSubpaths(path: string, subpaths: string[]): Promise<void> {
    await this.database;

    const entry = this.libraryPathsMap.get(path);
    if (entry === undefined) {
      return undefined;
    }

    entry.indexedSubpaths = subpaths;

    this.syncLibraryPathsQueue.push(async () => {
      const db = await this.database;
      const tx = db.transaction(TableNames.LibraryPaths, 'readwrite');
      const libraryPathsTable = tx.objectStore(TableNames.LibraryPaths);
      libraryPathsTable.put(entry);
    });
  }

  async resolveInLibraryPaths(file: PathsHandle): Promise<ResolvedSubpathInLibraryPath> {
    await this.database;
    const libraryPaths = Array.from(this.getLibraryPaths());
    let containedLibraryPath: LibraryPathEntry|null = null;
    let resolvedLibrarySubpath: string[]|null = null;
    for (const libraryPath of libraryPaths) {
      // TODO: Deal with permissions.
      if (!libraryPath.directoryHandle) {
        continue;
      }
      const resolvedPath = await libraryPath.directoryHandle.resolve(file);
      if (!resolvedPath) {
        continue;
      }
      containedLibraryPath = libraryPath;
      resolvedLibrarySubpath = resolvedPath;
      break;
    }
    if (!containedLibraryPath || !resolvedLibrarySubpath) {
      // Can't handle ephemeral paths yet.
      return { handle: file };
    }
    return {
      handle: file,
      libraryPath: containedLibraryPath,
      subpath: resolvedLibrarySubpath,
    };
  }

  getPlaylists(): PlaylistEntry[] {
    return this.playlists;
  }

  getPlaylistByKey(key: string): PlaylistEntry|undefined {
    return this.playlistsMap.get(key);
  }

  addPlaylist(name: string): PlaylistEntry {
    const newKey = crypto.randomUUID();
    const newEntry: PlaylistEntry = {
      key: newKey,
      name: name,
    };
    this.playlists.push(newEntry);
    this.playlistsMap.set(newKey, newEntry);

    this.syncPlaylistsQueue.push(async () => {
      const db = await this.database;
      const tx = db.transaction(TableNames.Playlists, 'readwrite');
      const playlistsTable = tx.objectStore(TableNames.Playlists);
      playlistsTable.put(newEntry);
    });

    return newEntry;
  }

  async getPlaylistContainedTrackPaths(key: string): Promise<string[]> {
    const db = await this.database;
    const tx = db.transaction(TableNames.AllTracks, 'readonly');
    const allTracksTable = tx.objectStore(TableNames.AllTracks);
    const inPlaylistIndex = allTracksTable.index(IndexNames.Playlists);
    const fullRange = IDBKeyRange.bound(
        Database.makePlaylistMinIndexKey(key),
        Database.makePlaylistMaxIndexKey(key));
    return await inPlaylistIndex.getAllKeys(fullRange) as string[];
  }

  static getPlaylistIndexKeyKey(indexKey: string): string {
    return indexKey.split('|').at(0) ?? '';
  }

  static getPlaylistIndexKeyIndex(indexKey: string): string {
    return indexKey.split('|').at(1) ?? '';
  }

  static makePlaylistIndexKey(key: string, index: number) {
    return `${key}|${index.toString().padStart(constants.PLAYLIST_INDEX_MAX_DIGITS, '0')}`;
  }

  static makePlaylistMinIndexKey(key: string) {
    return `${key}|${''.padStart(constants.PLAYLIST_INDEX_MAX_DIGITS, '0')}`;
  }

  static makePlaylistMaxIndexKey(key: string) {
    return `${key}|${''.padStart(constants.PLAYLIST_INDEX_MAX_DIGITS, '9')}`;
  }

  cursor(primarySource: ListPrimarySource, secondarySource: string|undefined, sortContext: SortContext|undefined, anchor?: TrackPositionAnchor) {
    return new TrackCursor(this, primarySource, secondarySource, sortContext, anchor);
  }

  async findTrackFirstIndex(source: ListSource, path: string): Promise<number|undefined> {
    const db = await this.database;
    const sortIndex = this.getSourceIndexlike(source, db);
    let keyRange = this.getSourceFullKeyRange(source);
    const fullKeyRangeLower = keyRange?.lower;
    const fullKeyRangeLowerOpen = keyRange?.lowerOpen;

    const allTracksTable = sortIndex.objectStore.transaction.objectStore(TableNames.AllTracks);
    const track = await allTracksTable.get(path) as Track;
    if (!track) {
      return undefined;
    }

    if (keyRange === undefined) {
      const sortContext = source.sortContext ?? SortContext.Index;
      const metadataKey = Database.getSortKeyForContext(track, sortContext);
      keyRange = IDBKeyRange.only(metadataKey);
    }

    const partialKeyRangeLower = keyRange?.lower;
    const partialKeyRangeLowerOpen = keyRange?.lowerOpen;

    let keyRangeBaseIndex = 0;
    if (partialKeyRangeLower && partialKeyRangeLower !== fullKeyRangeLower || partialKeyRangeLowerOpen !== fullKeyRangeLowerOpen) {
      // TODO: Handle closed partialKeyRangeLowerOpen.
      // We can do that by counting the number of rows in the key partialKeyRangeLower,
      // and subtracting that out.
      let baseRange: IDBKeyRange;
      if (fullKeyRangeLower) {
        baseRange = IDBKeyRange.bound(fullKeyRangeLower, partialKeyRangeLower, fullKeyRangeLowerOpen, false);
      } else {
        baseRange = IDBKeyRange.upperBound(partialKeyRangeLower, true);
      }
      keyRangeBaseIndex = await sortIndex.count(baseRange);
    }

    const cursor = await sortIndex.openCursor(keyRange);
    let searchIndex = 0;
    while (cursor) {
      const track = cursor.value as Track;
      if (track) {
        if (track.path === path) {
          return keyRangeBaseIndex + searchIndex;
        }
      }
      if (!await cursor.advance(1)) {
        break;
      }
      searchIndex++;
    }
    return undefined;
  }

  async fetchTracksInRange(source: ListSource, min: number, max: number): Promise<Track[]> {
    const db = await this.database;
    const sortIndex = this.getSourceIndexlike(source, db);
    const keyRange = this.getSourceFullKeyRange(source);

    const cursor = await sortIndex.openCursor(keyRange);
    if (!cursor) {
      return [];
    }
    min = Math.max(0, min);
    if (min > 0 && await cursor.advance(min) === null) {
      return [];
    }
    const results: Track[] = [];
    const readLength = max - min + 1;
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
    const keyRange = this.getSourceFullKeyRange(source);
    // const allTracksTable = tx.objectStore(TableNames.AllTracks);
    // const sortIndex = allTracksTable.index(sortContext);
    return await sortIndex.count(keyRange);
  }

  async fetchTrackByPath(path: string): Promise<Track|undefined> {
    const db = await this.database;
    const tx = db.transaction(TableNames.AllTracks, 'readonly');
    const allTracksTable = tx.objectStore(TableNames.AllTracks);
    const track = await allTracksTable.get(path);
    return track;
  }

  private getSourceFullKeyRange(source: ListSource) {
    if (source.source === ListPrimarySource.Playlist && source.secondary) {
      const key = source.secondary;
      const playlistRange = IDBKeyRange.bound(
          Database.makePlaylistMinIndexKey(key),
          Database.makePlaylistMaxIndexKey(key));
      return playlistRange;
    }
    return undefined;
  }

  private getSourceIndexlike(source: ListSource, db: IDBPDatabase) {
    return this.getSourceIndex(this.getSourceInnerIndexlike(source, db), source);
  }

  private getSourceInnerIndexlike(source: ListSource, db: IDBPDatabase) {
    const searchStatus = this.searchResultsStatus;
    function getTable(name: string) {
      return db.transaction([TableNames.AllTracks, name], 'readonly').objectStore(name);
    }

    switch (source.source) {
      default:
      case 'library':
        return getTable(TableNames.AllTracks);
      case 'search':
        switch (searchStatus) {
          default:
          case SearchResultStatus.NoQuery:
            // TODO: Return empty.
            return getTable(this.currentSearchTable);
          case SearchResultStatus.Partial:
            // TODO: Handle summary.
            return getTable(this.partialSearchTable);
          case SearchResultStatus.Ready:
            return getTable(this.currentSearchTable);
        }
        break;
      // case 'playlist':
    }
  }

  private getSourceIndex(store: IDBPObjectStore<unknown, ArrayLike<string>, any, 'readonly'>, source: ListSource) {
    if (source.source === ListPrimarySource.Playlist) {
      return store.index(IndexNames.Playlists);
    }
    return store.index(source.sortContext ?? SortContext.Index);
  }

  @action
  private setSearchResultStatus(status: SearchResultStatus, partialCount: number, partialResultsSummary: Track[] = []) {
    this.searchResultsStatus = status;
    this.partialSearchResultsAvailable = partialCount;
    this.partialSearchResultsSummary = partialResultsSummary;
    this.searchContextEpoch++;
  }

  public async updateTracks(trackPaths: string[], mode: UpdateMode, updaterFunc: TrackUpdaterFunc): Promise<string[]> {
    return await this.trackUpdaterQueue.push(async () => {
      const db = await this.database;
      const tx = db.transaction(this.updateTrackTables, 'readwrite');

      let insertCount = 0;
      const updatedPaths: string[] = [];
      let aborted = true;
      try {
        const allTrackKeyValues = await Promise.all(trackPaths.map<Promise<[string, Track|undefined]>>(
            async path => {
              const result = await this.fetchTrackForUpdate(path, mode, tx);
              if (!result) {
                return [path, undefined];
              }
              const [track, status] = result;
              if (status === UpdateStatus.Inserted) {
                insertCount++;
              }
              return [path, track];
            }));
        const updatableTracksMap = new Map<string, Track|undefined>(allTrackKeyValues);
        const touchedTrackPaths = new Set<string>();
        await updaterFunc((path) => {
          touchedTrackPaths.add(path);
          return updatableTracksMap.get(path);
        });
        for (const toUpdatePath of touchedTrackPaths) {
          const toUpdate = updatableTracksMap.get(toUpdatePath);
          if (toUpdate === undefined || toUpdate.path !== toUpdatePath) {
            continue;
          }
          for (const metadataPath of SORT_CONTEXTS_TO_METADATA_PATH.values()) {
            let metadataKey: any = toUpdate;
            for (let i = 0; i < metadataPath.length - 1; ++i) {
              const propPath = metadataPath[i];
              let nextMetadataKey = metadataKey[propPath];
              if (nextMetadataKey === undefined) {
                nextMetadataKey = {};
                metadataKey[propPath] = nextMetadataKey;
              }
              metadataKey = nextMetadataKey;
            }
            const lastPath = metadataPath[metadataPath.length - 1];
            if (metadataKey[lastPath] === undefined) {
              metadataKey[lastPath] = '';
            }
          }
          this.putTrack(toUpdate, tx);
          updatedPaths.push(toUpdatePath);
          aborted = false;
        }
      } catch {
        aborted = true;
        tx.abort();
      } finally {
        if (!aborted) {
          tx.commit();
          await tx.done;
          runInAction(() => {
            if (insertCount > 0 && updatedPaths.length > 0) {
              this.listChangeEpoch++;
            }
            if (updatedPaths.length > 0) {
              this.trackDataChangeEpoch++;
            }
          });
        }
      }
      console.log(`Updated tracks in database: ${updatedPaths}`);
      if (updatedPaths.length > 0) {
        this.onTrackPathsUpdated(updatedPaths);
      }
      return updatedPaths;
    });
  }

  private async fetchTrackForUpdate(path: string, mode: UpdateMode, tx: IDBPTransaction<unknown, string[], "readwrite">): Promise<[Track, UpdateStatus]|undefined> {
    if (!path) {
      return undefined;
    }

    const allTracks = tx.objectStore(TableNames.AllTracks);

    const oldTrack = await allTracks.get(path);
    switch (mode) {
      default:
      case 'upsert':
        break;
      case 'create_only':
        if (oldTrack !== undefined) {
          return undefined;
        }
        break;
      case 'update_only':
        if (oldTrack === undefined) {
          return undefined;
        }
        break;
    }
    if (!oldTrack) {
      return [{
        path: path,
        filePath: Database.getPathFilePath(path),
        addedDate: Date.now(),
        indexedDate: 0,
        indexedAtLastModifiedDate: 0,
        inPlaylists: [],
      }, UpdateStatus.Inserted];
    }
    return [oldTrack, UpdateStatus.Updated];
  }

  private putTrack(track: Track, tx: IDBPTransaction<unknown, string[], "readwrite">) {
    const allTracks = tx.objectStore(TableNames.AllTracks);
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
          path: track.path,
          prefixes: prefixes,
        };
        prefixTable.put(prefixEntry);
      }
      function generatePrefixes(str: string|undefined) {
        return Array.from(Database.generatePrefixes(str, prefixLength));
      }

      const pathPrefixes = generatePrefixes(track.filePath);
      const titlePrefixes = generatePrefixes(track.metadata?.title);
      const artistPrefixes = generatePrefixes(track.metadata?.artist);
      const albumPrefixes = generatePrefixes(track.metadata?.album);
      const genrePrefixes = generatePrefixes(track.metadata?.genre);
      const indexPrefixes = generatePrefixes(track.generatedMetadata?.librarySortKey);

      insertForContext(QueryTokenContext.All, [ pathPrefixes, titlePrefixes, artistPrefixes, albumPrefixes, genrePrefixes, indexPrefixes ]);
      insertForContext(QueryTokenContext.Title, [ titlePrefixes ]);
      insertForContext(QueryTokenContext.Artist, [ artistPrefixes ]);
      insertForContext(QueryTokenContext.Album, [ albumPrefixes ]);
      insertForContext(QueryTokenContext.Genre, [ genrePrefixes ]);
      insertForContext(QueryTokenContext.Index, [ indexPrefixes ]);
    }
  }

  setSearchQuery(query: QueryToken[]) {
    if (utils.isDeepStrictEqual(this.nextSearchQuery, query)) {
      return;
    }
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
      this.searchQueryUpdateInFlight = this.updateSearchTable(this.canonicalizeQuery(this.nextSearchQuery), cancelFlag);
    })();
  }

  private canonicalizeQuery(query: QueryToken[]): QueryToken[] {
    return query.map(token => {
      const copy = structuredClone(token);
      copy.text = copy.text.trim().toLocaleLowerCase();
      return copy;
    }).filter(token => token.text.length > 0);
  }

  private async updateSearchTable(queryTokens: QueryToken[], cancelFlag: utils.Resolvable<void>) {
    try {
      return await this.updateSearchTableInner(queryTokens, cancelFlag);
    } catch (e) {
      if (e === Canceled) {
        console.log("updateSearchTable canceled");
        return;
      }
      this.setSearchResultStatus(SearchResultStatus.NoQuery, 0);
      throw e;
    }
  }

  private async updateSearchTableInner(queryTokens: QueryToken[], cancelFlag: utils.Resolvable<void>) {
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
    const allTracksTable = tx.objectStore(TableNames.AllTracks);

    const minPrefixLength = constants.INDEXED_PREFIX_LENGTHS[0];
    const maxPrefixLength = constants.INDEXED_PREFIX_LENGTHS[constants.INDEXED_PREFIX_LENGTHS.length - 1];

    let hasBest = false;
    let bestCount = 0;
    let bestCursorFunc = undefined;
    for (const queryToken of queryTokens) {
      if (queryToken.text.length < minPrefixLength) {
        continue;
      }
      let prefixLength = Math.min(maxPrefixLength, queryToken.text.length);
      if (!constants.INDEXED_PREFIX_LENGTHS.includes(prefixLength)) {
        prefixLength = constants.INDEXED_PREFIX_LENGTHS.reduce((a, b) => b >= prefixLength ? a : b > a ? b : a, minPrefixLength);
      }

      const queryPrefix = queryToken.text.slice(0, prefixLength);

      let tokenContext: QueryTokenContext;
      switch (queryToken.atom) {
        case QueryTokenAtom.Title:
          tokenContext = QueryTokenContext.Title;
          break;
        case QueryTokenAtom.Artist:
          tokenContext = QueryTokenContext.Artist;
          break;
        case QueryTokenAtom.Album:
          tokenContext = QueryTokenContext.Album;
          break;
        case QueryTokenAtom.Genre:
          tokenContext = QueryTokenContext.Genre;
          break;
        case QueryTokenAtom.Path:
          // TODO: Fix.
          tokenContext = QueryTokenContext.All;
          break;
        default:
          tokenContext = QueryTokenContext.All;
          break;
      }

      const prefixTableName = Database.getPrefixIndexName(tokenContext, prefixLength);
      const prefixTable = tx.objectStore(prefixTableName);
      const prefixesIndex = prefixTable.index(IndexNames.Prefixes);
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
        this.setSearchResultStatus(SearchResultStatus.Partial, findCount, partialSummary);
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
      this.setSearchResultStatus(queryTokens.length === 0 ? SearchResultStatus.NoQuery : SearchResultStatus.Ready, findCount);
      console.log(`Scanned ${bestCount} entries to find ${findCount} results.`);
    } catch (e) {
      if (e === Canceled) {
        await searchTableAddFlow.join(true);
      }
      throw e;
    }
  }

  private queryMatchesTrack(queryTokens: QueryToken[], track: Track) {
    const path = track.filePath.toLocaleLowerCase();
    const title = track.metadata?.title?.toLocaleLowerCase();
    const artist = track.metadata?.artist?.toLocaleLowerCase();
    const album = track.metadata?.album?.toLocaleLowerCase();
    const genre = track.metadata?.genre?.toLocaleLowerCase();
    for (const queryToken of queryTokens) {
      const text = queryToken.text;
      let matches: boolean = false;
      switch (queryToken.atom) {
        case QueryTokenAtom.Title:
          matches = title?.includes(text) ?? false;
          break;
        case QueryTokenAtom.Artist:
          matches = artist?.includes(text) ?? false;
          break;
        case QueryTokenAtom.Album:
          matches = album?.includes(text) ?? false;
          break;
        case QueryTokenAtom.Genre:
          matches = genre?.includes(text) ?? false;
          break;
        case QueryTokenAtom.Path:
          // TODO: Fix.
          break;
        default:
          matches =
              path.includes(text) ||
              title?.includes(text) ||
              artist?.includes(text) ||
              album?.includes(text) ||
              genre?.includes(text) ||
              false;
          break;
      }
      if (!matches) {
        return false;
      }
    }
    return true;
  }

  private async openDatabaseAsync() {
    if (constants.DEBUG_RESET_DATABASE) {
      await deleteDB('data-tables');
    }
    let didUpgrade = false;
    const db = await openDB('data-tables', 1, {
      upgrade: (upgradeDb) => {
      const allTracksTable = upgradeDb.createObjectStore(TableNames.AllTracks, { keyPath: 'path' });
      for (const context of ALL_QUERY_TOKEN_CONTEXTS) {
        for (const prefixLength of constants.INDEXED_PREFIX_LENGTHS) {
          const prefixTableName = Database.getPrefixIndexName(context, prefixLength);
          const prefixTable = upgradeDb.createObjectStore(prefixTableName, { keyPath: 'path' });
          prefixTable.createIndex(IndexNames.Prefixes, 'prefixes', { unique: false, multiEntry: true });
        }
      }
      allTracksTable.createIndex(IndexNames.Playlists, 'inPlaylists', { unique: false, multiEntry: true });
      const searchTableA = upgradeDb.createObjectStore(SearchTableName.A, { keyPath: 'path' });
      const searchTableB = upgradeDb.createObjectStore(SearchTableName.B, { keyPath: 'path' });

      const allSortableTables = [allTracksTable, searchTableA, searchTableB];
      for (const table of allSortableTables) {
        for (const context of ALL_SORT_CONTEXTS) {
          const keyPath = SORT_CONTEXTS_TO_METADATA_PATH.get(context);
          if (!keyPath) {
            continue;
          }
          table.createIndex(context, keyPath.join('.'), { unique: false });
        }
      }

      upgradeDb.createObjectStore(TableNames.LibraryPaths, { keyPath: 'path' });
      upgradeDb.createObjectStore(TableNames.Playlists, { keyPath: 'key' });
      upgradeDb.createObjectStore(TableNames.Preferences, { keyPath: 'key' });

      didUpgrade = true;
      console.log(upgradeDb);
    }})

    if (didUpgrade) {
      if (environment.isElectron()) {
        this.syncLibraryPathsQueue.push(async () => {
          const tx = db.transaction(TableNames.LibraryPaths, 'readwrite');
          const libraryPathsTable = tx.objectStore(TableNames.LibraryPaths);
          libraryPathsTable.put({
            path: ROOT_SOURCE_KEY,
            directoryHandle: makeRootDirectoryHandle(),
            indexedSubpaths: [],
          });
        });
      }
    }

    const syncLibraryPathsOp = this.syncLibraryPathsQueue.push(async () => {
      const tx = db.transaction(TableNames.LibraryPaths, 'readonly');
      const libraryPathsTable = tx.objectStore(TableNames.LibraryPaths);
      this.libraryPaths = await libraryPathsTable.getAll() as LibraryPathEntry[];
      this.libraryPathsMap.clear();
      for (const entry of this.libraryPaths) {
        entry.directoryHandle = deserializePathsHandle(entry.directoryHandle);
        this.libraryPathsMap.set(entry.path, entry);
      }
      this.libraryPathsLoaded.resolve();
      await tx;
    });

    const syncPlaylistsOp = this.syncPlaylistsQueue.push(async () => {
      const tx = db.transaction(TableNames.Playlists, 'readonly');
      const playlistsTable = tx.objectStore(TableNames.Playlists);
      this.playlists = await playlistsTable.getAll() as PlaylistEntry[];
      this.playlistsMap.clear();
      for (const entry of this.playlists) {
        this.playlistsMap.set(entry.key, entry);
      }
      this.playlistsLoaded.resolve();
      await tx;
    });

    await syncLibraryPathsOp;
    await syncPlaylistsOp;
    return db;
  }

  static getSortKeyForContext(track: Track, sortContext: SortContext): string|undefined {
    const metadataPath = SORT_CONTEXTS_TO_METADATA_PATH.get(sortContext);
    if (!metadataPath) {
      return undefined;
    }
    let metadataKey: any = track;
    for (const propPath of metadataPath) {
      metadataKey = metadataKey[propPath];
      if (metadataKey === undefined) {
        break;
      }
    }
    if (typeof metadataKey !== 'string') {
      return undefined;
    }
    return metadataKey;
  }

  static getPathSourceKey(path: string) {
    const [sourceKey, filePath] = Database.getPathParts(path);
    return sourceKey;
  }

  static getPathFilePath(path: string) {
    const [sourceKey, filePath] = Database.getPathParts(path);
    return filePath;
  }

  static getAbsPathFilePath(path: string) {
    const [sourceKey, filePath] = Database.getPathParts(path);
    if (sourceKey === ROOT_SOURCE_KEY) {
      return filePath;
    }
    // throw new Error('Not available');
    return '/' + filePath;
  }

  public static makePath(sourceKey: string, filePathParts: string[]) {
    let filePath = filePathParts.join('/');
    if (sourceKey === ROOT_SOURCE_KEY && !filePath.startsWith('/')) {
      filePath = '/' + filePath;
    }
    return sourceKey + '|' + filePath;
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
      case SearchTableName.A:
        return SearchTableName.B;
      case SearchTableName.B:
        return SearchTableName.A;
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

export class ObservablePreferences<T extends Preferences> {
  private readonly preferencesKey;
  private readonly observableValue;
  private databaseValue: T;
  private changeEpoch = 0;
  private readonly opQueue = new utils.OperationQueue();
  private readonly loaded =  new utils.Resolvable<void>();

  get asObservable(): T {
    return this.observableValue;
  }

  async waitForLoad() {
    await this.loaded.promise;
  }

  constructor(readonly database: Database, readonly defaultValueConstructor: () => T) {
    const defaultValue = defaultValueConstructor();
    this.databaseValue = defaultValue;
    this.preferencesKey = defaultValue.key;
    this.observableValue = observable(defaultValue);
    this.opQueue.push(async () => {
      // Read from database.
      const database = await this.database.getRawDatabase();
      const tx = database.transaction(TableNames.Preferences, 'readonly');
      const prefsTable = tx.objectStore(TableNames.Preferences);
      const toMerge = await prefsTable.get(this.preferencesKey) as T;
      if (toMerge) {
        this.databaseValue = utils.mergeRec(this.defaultValueConstructor(), toMerge);
        runInAction(() => {
          utils.mergeRec(this.observableValue, toMerge);
        });
      }
      observe(this.observableValue, () => {
        this.queueSyncOperation();
      });
      this.loaded.resolve();
    });
  }

  private queueSyncOperation() {
    const thisEpoch = ++this.changeEpoch;
    this.opQueue.push(async () => {
      if (thisEpoch !== this.changeEpoch) {
        return;
      }
      // TODO: Deep merge.
      const toWrite = utils.mergeRec(this.defaultValueConstructor(), this.observableValue);
      if (utils.isDeepStrictEqual(toWrite, this.databaseValue)) {
        return;
      }
      this.databaseValue = toWrite;
      console.log(`Prefs write: ${JSON.stringify(toWrite)}`);
      const database = await this.database.getRawDatabase();
      toWrite.key = this.preferencesKey;
      const tx = database.transaction(TableNames.Preferences, 'readwrite');
      const prefsTable = tx.objectStore(TableNames.Preferences);
      await prefsTable.put(toWrite);
      tx.commit();
      await tx.done;
    });
  }
}

