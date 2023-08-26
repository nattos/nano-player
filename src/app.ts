import { html, css, LitElement, PropertyValueMap, render } from 'lit';
import {} from 'lit/html';
import { customElement, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { action, autorun, runInAction, observable, observe, makeObservable, override } from 'mobx';
import { RecyclerView } from './recycler-view';
import { CandidateCompletion, CommandParser, CommandResolvedArg, CommandSpec } from './command-parser';
import * as utils from './utils';
import * as constants from './constants';
import { TrackView, TrackViewHost } from './track-view';
import { Track } from './schema';
import { LIST_VIEW_PEEK_LOOKAHEAD } from './constants';
import { Database, ListPrimarySource, ListSource, SearchResultStatus, SortContext } from './database';
import { MediaIndexer } from './media-indexer';
import { TrackCursor } from './track-cursor';
import { CmdLibraryCommands, CmdLibraryPathsCommands, CmdSettingsGroupCommands, CmdSortTypes, getCommands } from './app-commands';
import { Playlist, PlaylistManager } from './playlist-manager';
import { Selection, SelectionMode } from './selection';

RecyclerView; // Necessary, possibly beacuse RecyclerView is templated?

@customElement('nano-app')
export class NanoApp extends LitElement {
  static instance?: NanoApp;

  @query('#query-input') queryInputElement!: HTMLInputElement;
  @query('#player-seekbar') playerSeekbarElement!: HTMLElement;
  @query('#track-list-view') trackListView!: RecyclerView<TrackView, Track>;
  readonly selection = new Selection<Track>();
  private readonly trackViewHost: TrackViewHost;
  readonly commandParser = new CommandParser(getCommands(this));

  private readonly audioElement = new Audio();

  constructor() {
    super();
    const thisCapture = this;

    this.audioElement.addEventListener('ended', this.onAudioEnded.bind(this));
    this.audioElement.addEventListener('error', this.onAudioError.bind(this));
    this.audioElement.addEventListener('timeupdate', this.onAudioTimeUpdate.bind(this));

    this.trackViewHost = {
      doPlayTrackView(trackView) {
        thisCapture.doPlayTrack(trackView.index, trackView.track);
      },
      doSelectTrackView: this.doSelectTrackView.bind(this),
    };
    this.selection.onSelectionChanged.add(this.updateSelectionInTrackView.bind(this));
    makeObservable(this);
    NanoApp.instance = this;
  }

  connectedCallback(): void {
    super.connectedCallback();

    navigator.mediaSession.setActionHandler('play', this.doPlay.bind(this));
    navigator.mediaSession.setActionHandler('pause', this.doPause.bind(this));
    navigator.mediaSession.setActionHandler('seekbackward', () => {});
    navigator.mediaSession.setActionHandler('seekforward', () => {});
    navigator.mediaSession.setActionHandler('previoustrack', this.doPreviousTrack.bind(this));
    navigator.mediaSession.setActionHandler('nexttrack', this.doNextTrack.bind(this));

    setTimeout(() => {
      const updateTracks = () => this.updateTrackDataInViewport();
      observe(Database.instance, 'searchResultsStatus', updateTracks);
      observe(Database.instance, 'searchContextEpoch', updateTracks);
      observe(Database.instance, 'listChangeEpoch', updateTracks);

      observe(this.trackListView, 'viewportMinIndex', updateTracks);
      observe(this.trackListView, 'viewportMaxIndex', updateTracks);
      updateTracks();

      autorun(() => { this.loadTrack(this.currentPlayTrack); });
      autorun(() => { this.setLoadedTrackPlaying(this.isPlaying); });

      MediaIndexer.instance.start();

      window.addEventListener('keypress', this.onWindowKeypress.bind(this));
      window.addEventListener('contextmenu', this.onWindowRightClick.bind(this));
    });
  }

  @observable queryInputForceShown = false;
  private requestFocusQueryInput = false;
  private queryPreviewing?: CandidateCompletion = undefined;

  @action
  private doToggleQueryInputField(state?: boolean, initialQuery?: string) {
    const newState = state ?? !this.queryInputForceShown;
    if (newState === this.queryInputForceShown) {
      return;
    }
    this.queryInputForceShown = newState;
    if (this.queryInputForceShown) {
      if (initialQuery !== undefined) {
        this.queryInputElement.value = initialQuery;
      }
      this.queryChanged();
      this.requestFocusQueryInput = true;
    } else {
      if (!this.isQueryInputVisible()) {
        this.doSearchCancelPreview();
      }
    }
  }

  @action
  private queryChanged() {
    const query = this.queryInputElement.value;
    let completions = this.commandParser.parse(query, true);
    const toPreview = completions.find(entry => entry.isComplete);

    completions = completions.filter(entry => !entry.isComplete);
    if (query.trim().length === 0) {
      completions = completions
          .concat(this.commandParser.parse('cmd:library show', true))
          .concat(this.commandParser.parse('playlist:'))
          .concat(this.commandParser.parse('cmd:'));
    }
    this.completions = completions;

    if (this.queryPreviewing?.forCommand && this.queryPreviewing?.resolvedArgs) {
      this.queryPreviewing.forCommand.cancelPreviewFunc?.(
          this.queryPreviewing.forCommand, this.queryPreviewing.resolvedArgs);
    }
    this.queryPreviewing = toPreview;
    if (this.queryPreviewing) {
      if (this.queryPreviewing?.forCommand && this.queryPreviewing?.resolvedArgs) {
        this.queryPreviewing.forCommand.beginPreviewFunc?.(
            this.queryPreviewing.forCommand, this.queryPreviewing.resolvedArgs);
      }
    }
  }

  @action
  private acceptQueryCompletion(completion: CandidateCompletion) {
    if (completion.resultQuery) {
      this.queryInputElement.value = completion.resultQuery;
      this.queryChanged();
      if (completion.forCommand?.executeOnAutoComplete) {
        this.doExecuteQuery();
      }
    }
  }

  @action
  private doExecuteQuery() {
    if (this.queryPreviewing?.forCommand && this.queryPreviewing?.resolvedArgs) {
      this.queryPreviewing.forCommand.cancelPreviewFunc?.(
          this.queryPreviewing.forCommand, this.queryPreviewing.resolvedArgs);
    }
    this.queryPreviewing = undefined;

    const query = this.queryInputElement.value;
    const result = this.commandParser.execute(query);
    if (result) {
      this.queryInputElement.value = '';
      this.queryChanged(); // HACK!!!
      this.queryInputForceShown = false;
    } else {
      if (query.trim().length === 0) {
        this.queryInputElement.value = '';
        this.queryChanged(); // HACK!!!
        this.doSearchClear();
        this.queryInputForceShown = false;
      }
    }
  }

  @action
  private queryAreaKeypress(e: KeyboardEvent) {
    console.log(e);
    // e.preventDefault();
    e.stopPropagation();
  }

  @action
  private queryAreaKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.doToggleQueryInputField(false);
    }
  }

  @action
  private queryKeypress(e: KeyboardEvent) {
    // console.log(e);
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.doExecuteQuery();
    }
  }

  @action
  onCompletionChipClicked(e: MouseEvent, c: CandidateCompletion) {
    if (e.button !== 0) {
      return;
    }
    this.acceptQueryCompletion(c);
  }

  private isQueryInputVisible(): boolean {
    return this.queryInputForceShown;
  }

  private isQueryUnderlayVisible(): boolean {
    return this.completions.length !== 0 || this.searchPreviewQuery.length === 0 || this.queryInputElement.value.length <= 3;
  }

  @action
  onQueryUnderlayClicked() {
    this.doToggleQueryInputField(false);
  }

  private searchAcceptedQuery: string[] = [];
  private searchPreviewQuery: string[] = [];
  private prevSearchQuery: string[] = [];
  private readonly searchUpdateQueue = new utils.OperationQueue();

  @action
  doSearchAccept(command: CommandSpec, args: CommandResolvedArg[]) {
    const query = this.searchQueryFromArgs(args);
    // if (query.length === 0) {
    //   this.doSearchClear();
    //   return;
    // }
    this.searchAcceptedQuery = query;
    console.log(`do search: ${query.join(' ')}`);
    this.updateDatabaseSearchQuery();
  }

  @action
  doSearchClear() {
    this.searchAcceptedQuery = [];
    this.searchPreviewQuery = [];
    this.prevSearchQuery = [];
    Database.instance.setSearchQuery([]);
  }

  @action
  doSearchBeginPreview(command: CommandSpec, args: CommandResolvedArg[]) {
    const query = this.searchQueryFromArgs(args);
    this.searchPreviewQuery = query;
    console.log(`do preview: ${query.join(' ')}`);
    this.updateDatabaseSearchQuery();
  }

  @action
  doSearchCancelPreview() {
    this.searchPreviewQuery = [];
    this.updateDatabaseSearchQuery();
  }

  private updateDatabaseSearchQuery(shortWaitCount = 0) {
    this.searchUpdateQueue.push(async () => {
      await utils.sleep(0);
      let nextQuery = this.searchAcceptedQuery;
      if (this.searchPreviewQuery.length > 0) {
        nextQuery = this.searchPreviewQuery;
      }
      const newQueryStr = nextQuery.join(' ');
      const oldQueryStr = this.prevSearchQuery.join(' ');
      if (newQueryStr === oldQueryStr) {
        return;
      }
      if (shortWaitCount < 4 && nextQuery.length > 0 && newQueryStr.length < 3) {
        await utils.sleep(50);
        this.updateDatabaseSearchQuery(shortWaitCount + 1);
        return;
      }
      this.prevSearchQuery = nextQuery;
      Database.instance.setSearchQuery(nextQuery);
      await utils.sleep(100);
    });
  }

  private searchQueryFromArgs(args: CommandResolvedArg[]): string[] {
    return Array.from(utils.filterNulllike(args.map(arg => arg.oneofValue ?? arg.stringValue)));
  }

  @action
  doLibraryPathsCmd(cmd: CmdLibraryPathsCommands) {
    switch (cmd) {
      case CmdLibraryPathsCommands.Show:
        console.log(JSON.stringify(Database.instance.getLibraryPaths()));
        break;
      case CmdLibraryPathsCommands.Add:
        this.doLibraryPathsAddFromDialog(false);
        break;
      case CmdLibraryPathsCommands.AddIndexed:
        this.doLibraryPathsAddFromDialog(true);
        break;
    }
  }

  @action
  async doLibraryPathsAddFromDialog(setAsIndexed: boolean) {
    const directoryHandle = await (window as any).showDirectoryPicker() as FileSystemDirectoryHandle;
    if (!directoryHandle) {
      return;
    }

    const libraryPaths = Database.instance.getLibraryPaths();
    let resolvedLibraryPath = undefined;
    let resolvedLibrarySubpath = undefined;
    for (const entry of libraryPaths) {
      const resolvedPath = await entry.directoryHandle?.resolve(directoryHandle);
      if (resolvedPath) {
        resolvedLibraryPath = entry;
        resolvedLibrarySubpath = resolvedPath;
        break;
      }
    }
    if (!resolvedLibraryPath) {
      resolvedLibraryPath = await Database.instance.addLibraryPath(directoryHandle);
      resolvedLibrarySubpath = [];
    }

    if (setAsIndexed) {
      const newPath = (resolvedLibrarySubpath ?? []).join('/');
      const oldPaths = resolvedLibraryPath.indexedSubpaths;
      const newPaths = Array.from(utils.filterUnique(oldPaths.concat(newPath)));
      Database.instance.setLibraryPathIndexedSubpaths(resolvedLibraryPath.path, newPaths);
      if (resolvedLibraryPath.directoryHandle) {
        // TODO: Centralize permission handling.
        // TODO: Deal with API.
        const permissionResult = await (resolvedLibraryPath.directoryHandle as any)?.requestPermission();
        if (permissionResult === 'granted') {
          MediaIndexer.instance.queueFileHandle(resolvedLibraryPath.directoryHandle, newPath);
        }
      }
    }

    console.log(JSON.stringify(Database.instance.getLibraryPaths()));
  }

  @action
  private onWindowKeypress(e: KeyboardEvent) {
    console.log(e);
    let captured = true;
    if (e.key === 'z' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.doPreviousTrack();
    } else if (e.key === 'x' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.doPlay();
    } else if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.doPause();
    } else if (e.key === 'v' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.doStop();
    } else if (e.key === 'b' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.doNextTrack();
    } else if (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.doPause();
    } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.doToggleQueryInputField(true, '');
    } else if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.doToggleQueryInputField(true, 'cmd:');
    } else {
      captured = false;
    }
    if (captured) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  @action
  private onWindowRightClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.doToggleQueryInputField(undefined, '');
  }

  @observable isPlaying = false;
  @observable currentPlayProgress = 0;
  @observable currentPlayProgressFraction = 0;
  @observable currentPlayTrack: Track|null = null;
  @observable currentPlayPlaylist: Playlist|null = null;
  private playLastDelta = 1;
  private playCursor?: TrackCursor;
  private playOpQueue = new utils.OperationQueue();

  @action
  doPlaySelected() {
  }

  @action
  doPlayTrack(atIndex: number, track: Track|undefined) {
    this.playOpQueue.push(async () => {
      const fromSource: ListSource = {
        source: this.trackViewCursor?.primarySource ?? ListPrimarySource.Auto,
        secondary: this.trackViewPlaylist,
        sortContext: this.trackViewCursor?.sortContext,
      };
      // TODO: Verify track matches.
      await this.movePlayCursor(0, atIndex, fromSource);
      this.setPlayState(true);
    });
  }

  doSelectTrackView(trackView: TrackView, mode: SelectionMode) {
    if (!trackView.track) {
      return;
    }
    this.selection.select(trackView.index, trackView.track, mode);
    this.updateSelectionInTrackView();
    if (trackView.track) {
      this.trackViewCursor?.setAnchor?.({ index: trackView.index, path: trackView.track.path });
    }
  }

  private updateSelectionInTrackView() {
    const [primaryIndex, primaryTrack] = this.selection.primary;
    for (const trackView of this.trackListView.elementsInView) {
      const index = trackView.index;
      trackView.selected = this.selection.has(index);
      trackView.highlighted = index === primaryIndex;
    }
  }

  private async movePlayCursor(delta: number, absPos?: number, fromSource?: ListSource) {
    this.playLastDelta = delta < 0 ? -1 : 1;

    let needsInitialSeek = false;
    if (!this.playCursor) {
      this.playCursor = Database.instance.cursor(
          ListPrimarySource.Library, undefined, this.trackViewCursor?.sortContext ?? SortContext.Index);
      needsInitialSeek = true;
    }
    if (fromSource) {
      this.playCursor.source = fromSource;
    }
    if (needsInitialSeek) {
      this.playCursor.seek(delta >= 0 ? -Infinity : Infinity);
    }

    const firstResults = this.playCursor.peekRegion(0, 0);
    if (firstResults.updatedResultsPromise) {
      await firstResults.updatedResultsPromise;
    }
    let nextIndex: number;
    if (absPos === undefined) {
      nextIndex = this.playCursor.index + delta;
    } else {
      nextIndex = Math.max(0, Math.min(this.playCursor.trackCount, absPos)) + delta;
    }
    if (nextIndex >= this.playCursor.trackCount) {
      nextIndex -= this.playCursor.trackCount;
    }
    if (nextIndex < 0) {
      nextIndex += this.playCursor.trackCount;
    }
    this.playCursor.seek(nextIndex);

    const secondResults = this.playCursor.peekRegion(0, 0);
    let foundTrack: Track|undefined;
    if (secondResults.updatedResultsPromise) {
      const secondFetch = await secondResults.updatedResultsPromise;
      for (const track of secondFetch.results) {
        foundTrack = track;
        break;
      }
    } else {
      for (const track of secondResults.dirtyResults.results) {
        foundTrack = track;
        break;
      }
    }
    this.playCursor.setAnchor(foundTrack ? { index: this.playCursor.index, path: foundTrack.path } : undefined);

    let fromPlaylist: Playlist|undefined = undefined;
    const resolvedSource = this.resolveSource(this.playCursor.source);
    if (resolvedSource.source === ListPrimarySource.Playlist && resolvedSource.secondary) {
      fromPlaylist = await PlaylistManager.instance.getPlaylist(resolvedSource.secondary);
    }
    runInAction(() => {
      console.log(`currentPlayTrack: ${foundTrack?.path}`);
      this.currentPlayTrack = foundTrack ?? null;
      this.currentPlayPlaylist = fromPlaylist ?? null;
      if (foundTrack) {
        this.selection.select(nextIndex, foundTrack, SelectionMode.SetPrimary);
        this.trackListView.ensureVisible(nextIndex, constants.ENSURE_VISIBLE_PADDING);
      }
      this.cancelAudioSeek();
    });
  }

  private setPlayState(isPlaying: boolean) {
    runInAction(() => {
      this.isPlaying = isPlaying;
    });
  }

  private setPlayPosition(positionFraction: number) {
    runInAction(() => {
      if (this.audioElement.duration > 0) {
        const pos = this.audioElement.duration * positionFraction;
        this.audioElement.currentTime = pos;
        this.currentPlayProgress = pos;
        this.currentPlayProgressFraction = positionFraction;
      }
    });
  }

  @action
  doPlay() {
    this.playOpQueue.push(async () => {
      if (!this.currentPlayTrack) {
        await this.movePlayCursor(0);
      }
      if (this.isPlaying) {
        this.setPlayPosition(0);
      } else {
        this.setPlayState(true);
      }
    });
  }

  @action
  doPause() {
    this.playOpQueue.push(() => {
      this.setPlayState(!this.isPlaying);
    });
  }

  @action
  doStop() {
    this.playOpQueue.push(() => {
      this.setPlayState(false);
      this.setPlayPosition(0);
    });
  }

  @action
  doPreviousTrack() {
    this.playOpQueue.push(async () => {
      await this.movePlayCursor(-1);
    });
  }

  @action
  doNextTrack() {
    this.playOpQueue.push(async () => {
      await this.movePlayCursor(1);
    });
  }

  @action
  doSortList(sortType: CmdSortTypes) {
    let sortContext: SortContext|undefined = undefined;
    switch (sortType) {
      case CmdSortTypes.Title:
        sortContext = SortContext.Title;
        break;
      case CmdSortTypes.Artist:
        sortContext = SortContext.Artist;
        break;
      case CmdSortTypes.Genre:
        sortContext = SortContext.Genre;
        break;
      case CmdSortTypes.Album:
        sortContext = SortContext.Album;
        break;
      case CmdSortTypes.LibraryOrder:
        sortContext = SortContext.Index;
        break;
    }
    this.trackViewSortContext = sortContext;
    this.updateTrackDataInViewport();
  }

  @action
  async doLibraryCmd(command?: CmdLibraryCommands) {
    switch (command) {
      case CmdLibraryCommands.Reindex:
        this.doReindexLibrary();
        break;
      default:
      case CmdLibraryCommands.Show:
        this.doLibraryShow();
        break;
    }
  }

  getLibraryCmdChipLabel(command?: CmdLibraryCommands): string|undefined {
    switch (command) {
      default:
      case CmdLibraryCommands.Reindex:
        return undefined;
      case CmdLibraryCommands.Show:
        return 'show';
    }
  }

  @action
  doLibraryShow() {
    this.trackViewPlaylist = undefined;
    this.trackViewCursor!.primarySource = ListPrimarySource.Auto;
    this.updateTrackDataInViewport();
  }

  @action
  async doReindexLibrary() {
    for (const libraryPath of Database.instance.getLibraryPaths()) {
      if (libraryPath.directoryHandle === undefined || libraryPath.indexedSubpaths.length === 0) {
        continue;
      }
      // TODO: Centralize permission handling.
      // TODO: Deal with API.
      const permissionResult = await (libraryPath.directoryHandle as any)?.requestPermission();
      if (permissionResult !== 'granted') {
        continue;
      }
      for (const subpath of libraryPath.indexedSubpaths) {
        MediaIndexer.instance.queueFileHandle(libraryPath.directoryHandle, subpath);
      }
    }
  }

  @action
  async doPlaylistShow(playlistArgStr: string) {
    const playlist = await this.resolvePlaylistArg(playlistArgStr);
    if (playlist ===  undefined) {
      return;
    }
    console.log(playlist.entryPaths.join(', '));
    this.trackViewPlaylist = playlist.key;
    this.trackViewCursor!.primarySource = ListPrimarySource.Playlist;
    this.updateTrackDataInViewport();
  }

  @action
  async doPlaylistAddSelected(playlistArgStr: string) {
    const playlist = await this.resolvePlaylistArg(playlistArgStr);
    if (playlist === undefined) {
      return;
    }

    const pathPromises: Array<Promise<string>> = [];
    for (const index of this.selection.all) {
      pathPromises.push((async () => {
        const peek = this.trackViewCursor!.peekRegion(index, index, true);
        let results = peek.dirtyResults;
        if (peek.updatedResultsPromise) {
          results = await peek.updatedResultsPromise;
        }
        if (results.rebasedStartIndex !== index) {
          throw new Error('Interrupted.');
        }
        return Array.from(results.results)[0]!.path;
      })());
    }
    const paths: string[] = await Promise.all(pathPromises);
    const newEntries = Array.from(playlist.entryPaths).concat(paths);
    await PlaylistManager.instance.updatePlaylist(playlist.key, newEntries);
    this.updateTrackDataInViewport();

    console.log(playlist.entryPaths.join(', '));
  }

  @action
  async doPlaylistRemoveSelected() {
    if (this.trackViewPlaylist === undefined) {
      return;
    }
    const playlist = await PlaylistManager.instance.getPlaylist(this.trackViewPlaylist);
    if (playlist === undefined) {
      return;
    }

    const indicesToRemove = Array.from(this.selection.all).sort().reverse();
    const newEntries = Array.from(playlist.entryPaths);
    for (const indexToRemove of indicesToRemove) {
      newEntries.splice(indexToRemove, 1);
    }
    await PlaylistManager.instance.updatePlaylist(playlist.key, newEntries);
    this.selection.clear();
    this.updateTrackDataInViewport();

    console.log(playlist.entryPaths.join(', '));
  }

  @action
  async doPlaylistClear(playlistArgStr: string) {
    const playlist = await this.resolvePlaylistArg(playlistArgStr);
    if (playlist === undefined) {
      return;
    }
    await PlaylistManager.instance.updatePlaylist(playlist.key, []);
    this.updateTrackDataInViewport();
  }

  @action
  async doPlaylistNew(playlistName: string) {
    const newEntry = Database.instance.addPlaylist(playlistName);
    console.log(`Created ${newEntry.name} : ${newEntry.key}`);
    this.trackViewPlaylist = newEntry.key;
    this.trackViewCursor!.primarySource = ListPrimarySource.Playlist;
    this.updateTrackDataInViewport();
  }

  @action
  async doPlaylistDebugList() {
    const strs = await Promise.all(Database.instance.getPlaylists().map(async entry => {
      const playlist = await PlaylistManager.instance.getPlaylist(entry.key);
      let countStr = '<unknown/missing>';
      if (playlist !== undefined) {
        countStr = `count: ${playlist.entryPaths.length}`;
      }
      return `${entry.key} | ${entry.name} (${countStr})`;
    }));
    console.log(strs.join('\n'));
  }

  private async resolvePlaylistArg(playlistArgStr: string): Promise<Playlist|undefined> {
    const playlists = Database.instance.getPlaylists();
    let entry =
        playlists.find(entry => entry.key === playlistArgStr) ??
        playlists.find(entry => entry.name === playlistArgStr);
    if (entry === undefined) {
      return;
    }
    const playlistKey = entry.key;
    return await PlaylistManager.instance.getPlaylist(playlistKey);
  }

  private renderAutorunDisposer = () => {};
  private renderAutorunDirty = true;
  private renderIsInRender = false;
  private renderAutorunResult = html``;

  private trackViewPlaylist?: string;
  private trackViewSortContext = SortContext.Index;
  private trackViewCursor?: TrackCursor;
  @observable tracksInView: Array<Track|undefined> = [];
  tracksInViewBaseIndex = 0;

  @observable completions: CandidateCompletion[] = [];

  @action
  private updateTrackDataInViewport() {
    if (!this.trackViewCursor) {
      this.trackViewCursor = Database.instance.cursor(ListPrimarySource.Auto, undefined, undefined);
    }

    const blockSize = LIST_VIEW_PEEK_LOOKAHEAD;
    const viewportMinIndex = this.trackListView.viewportMinIndex;
    const viewportMaxIndex = this.trackListView.viewportMaxIndex;
    const peekMin = Math.max(0, (Math.floor(viewportMinIndex / blockSize) - 1) * blockSize);
    const peekMax = (Math.ceil(viewportMaxIndex / blockSize) + 1) * blockSize;
    const cursorPos = Math.round((peekMin + peekMax) / 2);
    const oldAnchor = this.trackViewCursor.anchor;

    this.trackViewCursor.seek(cursorPos);
    const results = this.trackViewCursor.peekRegion(peekMin - cursorPos, peekMax - cursorPos);
    const dirtyResults = results.dirtyResults;
    const updatedResultsPromise = results.updatedResultsPromise;

    this.tracksInView = Array.from(dirtyResults.results);
    this.tracksInViewBaseIndex = dirtyResults.rebasedStartIndex;
    this.trackListView?.rangeUpdated(dirtyResults.rebasedStartIndex, dirtyResults.rebasedEndIndex);

    const [oldSelectionIndex, oldSelectionTrack] = this.selection.primary;
    if (updatedResultsPromise) {
      updatedResultsPromise.then(action((updatedResults) => {
        console.log("Track results updated async");
        this.tracksInView = Array.from(updatedResults.results);
        this.tracksInViewBaseIndex = updatedResults.rebasedStartIndex;
        this.trackListView.rangeUpdated(updatedResults.rebasedStartIndex, updatedResults.rebasedEndIndex);
        this.trackListView.totalCount = updatedResults.totalCount;
        if (updatedResults.rebasedDelta !== undefined) {
          if (oldAnchor) {
            let newIndex = oldAnchor.index + updatedResults.rebasedDelta;
            setTimeout(() => {
              this.trackListView.ensureVisible(newIndex, constants.ENSURE_VISIBLE_PADDING);
            });
          }
          const newAnchor = this.trackViewCursor?.anchor;
          if (results.contextChanged && newAnchor && newAnchor.path === oldSelectionTrack?.path) {
            this.selection.select(newAnchor.index, oldSelectionTrack, SelectionMode.SetPrimary);
          }
        }
      }));
    }
    if (results.contextChanged) {
      this.selection.clear();
    }
  }

  resolveSource(source: ListSource): ListSource {
    const newSource: ListSource = {
      source: source.source,
      secondary: source.secondary,
      sortContext: source.sortContext ?? this.trackViewSortContext,
    };
    const searchStatus = Database.instance.searchResultsStatus;
    if (newSource.source === ListPrimarySource.Auto) {
      newSource.source = (searchStatus === SearchResultStatus.NoQuery ? ListPrimarySource.Library : ListPrimarySource.Search);
    }
    if (newSource.source === ListPrimarySource.Playlist) {
      newSource.secondary = newSource.secondary ?? this.trackViewPlaylist;
    }
    return newSource;
  }

  protected override update(changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>): void {
    if (changedProperties.size > 0) {
      this.renderAutorunDirty = true;
    }
    super.update(changedProperties);
  }

  override render() {
    this.renderIsInRender = true;
    if (this.renderAutorunDirty) {
      this.renderAutorunDisposer?.();
      this.renderAutorunDisposer = autorun(() => {
        this.renderAutorunDirty = false;
        this.renderAutorunResult = this.renderInner();
        if (!this.renderIsInRender) {
          this.requestUpdate();
        }
      });
    }
    this.renderIsInRender = false;
    return this.renderAutorunResult;
  }

  @action
  private async loadTrack(track: Track|undefined|null) {
    if (!track || !track.fileHandle) {
      return;
    }
    const sourceKey = Database.getPathSourceKey(track.path);
    const libraryPath = Database.instance.findLibraryPath(sourceKey);
    if (!libraryPath) {
      return;
    }
    // TODO: Centralize permission handling.
    // TODO: Deal with API.
    const permissionResult = await (libraryPath.directoryHandle as any)?.requestPermission();
    if (permissionResult !== 'granted') {
      return;
    }
    try {
      const file = await track.fileHandle.getFile();
      this.audioElement.src = URL.createObjectURL(file);
      this.setLoadedTrackPlaying(this.isPlaying);
    } catch (e) {
      console.error(e);
      this.audioElement.src = '';
    }
  }

  @action
  private setLoadedTrackPlaying(isPlaying: boolean) {
    if (this.audioElement.paused === !isPlaying) {
      return;
    }
    if (isPlaying) {
      this.audioElement.play();
    } else {
      this.audioElement.pause();
    }
  }

  private onAudioEnded() {
    this.doNextTrack();
  }

  private onAudioError() {
    this.movePlayCursor(this.playLastDelta);
  }

  private onAudioTimeUpdate() {
    const loadedTrack = this.currentPlayTrack;
    setTimeout(() => { runInAction(() => {
      if (this.currentPlayTrack !== loadedTrack) {
        return;
      }
      const pos = this.audioElement!.currentTime;
      const duration = this.audioElement!.duration;
      this.currentPlayProgress = pos;
      this.currentPlayProgressFraction = duration > 0 ? (pos / duration) : 0;
    }); });
  }

  private isAudioSeeking = false;
  private audioSeekingPointerId = 0;

  @action
  private onAudioStartSeek(e: PointerEvent) {
    if (this.isAudioSeeking || e.button !== 0) {
      return;
    }
    this.isAudioSeeking = true;
    this.audioSeekingPointerId = e.pointerId;
    this.playerSeekbarElement.setPointerCapture(this.audioSeekingPointerId);
    e.preventDefault()
    window.addEventListener('pointermove', this.onAudioContinueSeek.bind(this));
    window.addEventListener('pointerup', this.onAudioEndSeek.bind(this));
    window.addEventListener('pointercancel', this.onAudioEndSeek.bind(this));
    this.audioDoSeek(e.pageX);
  }

  @action
  private onAudioContinueSeek(e: PointerEvent) {
    if (!this.isAudioSeeking || e.pointerId !== this.audioSeekingPointerId) {
      return;
    }
    this.audioDoSeek(e.pageX);
  }

  @action
  private onAudioEndSeek(e: PointerEvent) {
    if (!this.isAudioSeeking || e.pointerId !== this.audioSeekingPointerId) {
      return;
    }
    this.cancelAudioSeek();
  }

  private cancelAudioSeek() {
    if (!this.isAudioSeeking) {
      return;
    }
    this.playerSeekbarElement.releasePointerCapture(this.audioSeekingPointerId);
    this.isAudioSeeking = false;
    console.log('onAudioEndSeek');
    window.removeEventListener('pointermove', this.onAudioContinueSeek.bind(this));
    window.removeEventListener('pointerup', this.onAudioEndSeek.bind(this));
    window.removeEventListener('pointercancel', this.onAudioEndSeek.bind(this));
  }

  private audioDoSeek(pageX: number) {
    const clientRect = this.playerSeekbarElement.getBoundingClientRect();
    const fraction = (pageX - clientRect.left) / Math.max(1, clientRect.width);
    this.setPlayPosition(fraction);
  }

  static styles = css`
.hidden {
  visibility: hidden;
}

.click-target {
  user-select: none;
}

.outer {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-flow: column;
}

.track-view-area {
  flex-grow: 1;
  height: 0;
  position: relative;
}
.track-view {
}

.player {
  position: relative;
  flex: none;
  --player-height: 7em;
  background-color: var(--theme-bg2);
  width: 100%;
  height: var(--player-height);
  display: grid;
  grid-auto-columns: auto minmax(0, 1fr) auto;
  grid-auto-rows: 0.6fr 1fr;
}
.player-divider {
  position: absolute;
  top: -1px;
  height: 1px;
  left: 0;
  right: 0;
  background-color: var(--theme-bg2);
}
.player-top-shade {
  position: absolute;
  bottom: 0;
  height: 3em;
  left: 0;
  right: 0;
  --theme-bg4-alpha: rgba(var(--theme-bg4), 0);
  background: linear-gradient(0deg, var(--theme-bg4) 0%, transparent 100%);
  opacity: 0.3;
  pointer-events: none;
}
.player-artwork {
  height: var(--player-height);
  width: var(--player-height);
  background-color: var(--theme-bg3);
  grid-area: 1 / 1 / span 2 / span 1;
}
.player-info {
  display: flex;
  width: fit-content;
  max-width: 100%;
  align-items: center;
  margin: 0 1em;
  gap: 1em;
}
.player-info > div {
  flex-shrink: 1;
  flex-grow: 1;
  flex-basis: auto;
  text-wrap: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
.player-title {}
.player-artist {}
.player-album {}
.player-seekbar {
  grid-area: 2 / 2 / span 1 / span 3;
  background-color: var(--theme-bg2);
}
.player-seekbar-bar {
  height: 100%;
  background-color: var(--theme-color4);
}
.player-controls {
  display: flex;
  margin: 0 3em 0 1em;
  align-items: stretch;
  justify-content: flex-end;
  width: 15em;
  white-space: nowrap;
}

.player-controls > .small-button {
  display: flex;
  flex-grow: 1;
}
.player-controls > .small-button:hover {
  background-color: var(--theme-color4);
}
.player-controls-button-text {
  margin: auto;
  letter-spacing: 0.1em;
}

.query-container {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  z-order: 50;
}

.query-input-underlay {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  background-color: var(--theme-bg4);
  opacity: 0.5;
  user-select: none;
  pointer-events: auto;
}

.query-input-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-flow: column;
}

.query-input-area {
  height: 4em;
  background-color: var(--theme-bg);
  margin: 2em 10em;
  min-width: 300px;
  border-radius: 2em;
  border: solid var(--theme-fg2) 1px;
  pointer-events: auto;
}

.query-input {
  position: relative;
  bottom: 0.075em;
  width: 100%;
  height: 100%;
  font-size: 200%;
  border: none;
  background-color: transparent;
  margin: 0 1em;
  outline: none;
}

input {
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-weight: 300;
  color: var(--theme-fg);
}

.query-completion-area {
  display: flex;
  justify-content: center;
  gap: 1em;
  font-size: 200%;
  flex-flow: wrap;
  width: 80%;
  align-self: center;
  align-items: center;
}

.query-completion-chip {
  overflow: hidden;
  text-wrap: nowrap;
  text-overflow: ellipsis;
  background-color: var(--theme-color3);
  border-radius: 1.5em;
  padding: 0.5em 1em;
  pointer-events: auto;
}

.query-completion-chip:hover {
  background-color: var(--theme-color4);
}

.query-completion-chip-label {
}

.query-completion-chip-tag {
  font-size: 40%;
  letter-spacing: 0.05em;
  font-weight: 400;
}

  `;

  renderInner() {
    return html`
<div class="outer">
  <div class="track-view-area">
    <recycler-view class="track-view" id="track-list-view"></recycler-view>
    <div class=${classMap({
            'query-container': true,
            'hidden': !this.isQueryInputVisible(),
        })}>
      <div class=${classMap({
            'query-input-underlay': true,
            'hidden': !this.isQueryUnderlayVisible(),
        })}
          @click=${this.onQueryUnderlayClicked}>
      </div>
      <div class="query-input-overlay">
        <div class="query-input-area" @keypress=${this.queryAreaKeypress} @keydown=${this.queryAreaKeydown}>
          <input id="query-input" class="query-input" @input=${this.queryChanged} @keypress=${this.queryKeypress}></input>
        </div>
        <div class="query-completion-area">
          ${this.completions.map(c => html`
            <div class="query-completion-chip click-target" @click=${(e: MouseEvent) => this.onCompletionChipClicked(e, c)}>
              <div class="query-completion-chip-label">${c.byValue ?? c.byCommand?.atomPrefix ?? '<unknown>'}</div>
              <div class="query-completion-chip-tag">${getChipLabel(c)}</div>
            </div>
          `)}
        </div>
      </div>
    </div>
  </div>

  <div class="player">
    <div class="player-divider">
      <div class="player-top-shade"></div>
    </div>
    <div class="player-artwork"></div>
    <div class="player-info">
      <div class="player-title">${this.currentPlayTrack?.metadata?.title}</div>
      <div class="player-artist">${this.currentPlayTrack?.metadata?.artist}</div>
      <div class="player-album">${this.currentPlayTrack?.metadata?.album}</div>
    </div>
    <div class="player-controls">
      <span class="small-button click-target" @click=${this.doPreviousTrack}><div class="player-controls-button-text">[|&lt;]</div></span>
      <span class="small-button click-target" @click=${this.doPlay}><div class="player-controls-button-text">[|&gt;]</div></span>
      <span class="small-button click-target" @click=${this.doPause}><div class="player-controls-button-text">[II]</div></span>
      <span class="small-button click-target" @click=${this.doStop}><div class="player-controls-button-text">[#]</div></span>
      <span class="small-button click-target" @click=${this.doNextTrack}><div class="player-controls-button-text">[&gt;|]</div></span>
      <span class="small-button click-target" @click=${() => {this.doToggleQueryInputField();}}><div class="player-controls-button-text">Q</div></span>
    </div>
    <div
        id="player-seekbar"
        class="player-seekbar click-target"
        @pointerdown=${this.onAudioStartSeek}
        >
      <div class="player-seekbar-bar" style=${styleMap({'width': `${Math.max(0, Math.min(1, this.currentPlayProgressFraction)) * 100}%`})}>
      </div>
    </div>
  </div>
</div>
`;
  }

  protected updated(changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>): void {
    super.updated(changedProperties);

    this.trackListView!.elementConstructor = () => new TrackView();
    this.trackListView!.elementDataSetter = (trackView, index, track) => {
      trackView.index = index;
      trackView.track = track;
      trackView.host = this.trackViewHost;

      const [primaryIndex, primaryTrack] = this.selection.primary;
      trackView.selected = this.selection.has(index);
      trackView.highlighted = index === primaryIndex;
    };
    this.trackListView!.dataGetter = (index) => this.tracksInView.at(index - this.tracksInViewBaseIndex);
    this.trackListView.ready();

    if (this.requestFocusQueryInput) {
      this.queryInputElement.focus();
    }
  }
}

function getChipLabel(c: CandidateCompletion): string|undefined {
  if (c.forCommand?.chipLabel) {
    return c.forCommand?.chipLabel;
  }
  if (c.forCommand && c.resolvedArgs) {
    return c.forCommand.chipLabelFunc?.(c.forCommand, c.resolvedArgs)
  }
  return undefined;
}
