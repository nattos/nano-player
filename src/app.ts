import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, query} from 'lit/decorators.js';
import { action, autorun, runInAction, observable, observe, makeObservable } from 'mobx';
import { RecyclerView } from './recycler-view';
import { CandidateCompletion, CommandParser } from './command-parser';
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

  static styles = css`
.click-target {
  user-select: none;
}
  `;

  @query('#search-query-textarea') searchQueryTextarea!: HTMLTextAreaElement;
  @query('#audio-player') audioElement!: HTMLAudioElement;
  @query('#track-list-view') trackListView!: RecyclerView<TrackView, Track>;
  readonly selection = new Selection<Track>();
  private readonly trackViewHost: TrackViewHost;
  readonly commandParser = new CommandParser(getCommands(this));

  constructor() {
    super();
    const thisCapture = this;
    this.trackViewHost = {
      doPlayTrackView(trackView) {
        thisCapture.doPlayTrack(trackView.index, trackView.track);
      },
      doSelectTrackView: this.doSelectTrackView.bind(this),
    };
    makeObservable(this);
    NanoApp.instance = this;
  }

  connectedCallback(): void {
    super.connectedCallback();
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

      (async () => {
        await Database.instance.waitForLoad();
        this.queryChanged();
      })();

      MediaIndexer.instance.start();
    });
  }

  @action
  private queryChanged() {
    const query = this.searchQueryTextarea.value;
    this.completions = this.commandParser.parse(query);
    if (query.trim().length === 0) {
      this.completions = this.completions
          .concat(this.commandParser.parse('cmd:library show', true))
          .concat(this.commandParser.parse('playlist:'))
          .concat(this.commandParser.parse('cmd:'));
    }
  }
  @action
  private acceptQueryCompletion(completion: CandidateCompletion) {
    if (completion.resultQuery) {
      this.searchQueryTextarea.value = completion.resultQuery;
      this.queryChanged();
      if (completion.forCommand?.executeOnAutoComplete) {
        this.doExecuteQuery();
      }
    }
  }

  @action
  private doExecuteQuery() {
    const result = this.commandParser.execute(this.searchQueryTextarea.value);
    if (result) {
      this.searchQueryTextarea.value = '';
      this.queryChanged(); // HACK!!!
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

  @observable isPlaying = false;
  @observable currentPlayTrack: Track|null = null;
  @observable currentPlayPlaylist: Playlist|null = null;
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
    const [primaryIndex, primaryTrack] = this.selection.primary;
    for (const trackView of this.trackListView.elementsInView) {
      const index = trackView.index;
      trackView.selected = this.selection.has(index);
      trackView.highlighted = index === primaryIndex;
    }
  }

  private async movePlayCursor(delta: number, absPos?: number, fromSource?: ListSource) {
    let needsInitialSeek = false;
    if (!this.playCursor) {
      this.playCursor = Database.instance.cursor(
          ListPrimarySource.Library, undefined, this.trackViewCursor?.sortContext ?? SortContext.Index, {});
      needsInitialSeek = true;
    }
    if (fromSource) {
      this.playCursor.source = fromSource;
    }
    if (needsInitialSeek) {
      this.playCursor.seek(delta >= 0 ? 0 : Infinity);
    }

    const firstResults = this.playCursor.peekRegion(0, 0);
    if (firstResults.updatedResultsPromise) {
      await firstResults.updatedResultsPromise;
    }
    let nextIndex;
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

    let fromPlaylist: Playlist|undefined = undefined;
    const resolvedSource = this.resolveSource(this.playCursor.source);
    if (resolvedSource.source === ListPrimarySource.Playlist && resolvedSource.secondary) {
      fromPlaylist = await PlaylistManager.instance.getPlaylist(resolvedSource.secondary);
    }
    runInAction(() => {
      console.log(`currentPlayTrack: ${foundTrack?.path}`);
      this.currentPlayTrack = foundTrack ?? null;
      this.currentPlayPlaylist = fromPlaylist ?? null;
    });
  }

  private setPlayState(isPlaying: boolean) {
    runInAction(() => {
      this.isPlaying = isPlaying;
    });
  }

  private setPlayPosition(positionFraction: number) {
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
      this.trackViewCursor = Database.instance.cursor(ListPrimarySource.Auto, undefined, undefined, {});
    }

    const blockSize = LIST_VIEW_PEEK_LOOKAHEAD;
    const viewportMinIndex = this.trackListView.viewportMinIndex;
    const viewportMaxIndex = this.trackListView.viewportMaxIndex;
    const peekMin = Math.max(0, (Math.floor(viewportMinIndex / blockSize) - 1) * blockSize);
    const peekMax = (Math.ceil(viewportMaxIndex / blockSize) + 1) * blockSize;
    const cursorPos = Math.round((peekMin + peekMax) / 2);

    this.trackViewCursor.seek(cursorPos);
    const results = this.trackViewCursor.peekRegion(peekMin - cursorPos, peekMax - cursorPos);
    const dirtyResults = results.dirtyResults;
    const updatedResultsPromise = results.updatedResultsPromise;

    this.tracksInView = Array.from(dirtyResults.results);
    this.tracksInViewBaseIndex = dirtyResults.rebasedStartIndex;
    this.trackListView?.rangeUpdated(dirtyResults.rebasedStartIndex, dirtyResults.rebasedEndIndex);
    if (updatedResultsPromise) {
      updatedResultsPromise.then(action((updatedResults) => {
        console.log("Track results updated async");
        this.tracksInView = Array.from(updatedResults.results);
        this.tracksInViewBaseIndex = updatedResults.rebasedStartIndex;
        this.trackListView?.rangeUpdated(updatedResults.rebasedStartIndex, updatedResults.rebasedEndIndex);
        this.trackListView.totalCount = updatedResults.totalCount;
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
      const wasPlaying = !this.audioElement.paused;
      this.audioElement.src = URL.createObjectURL(file);
      this.setLoadedTrackPlaying(wasPlaying);
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

  renderInner() {
    return html`
<div>
  <div>
    <audio id="audio-player" controls></audio>
    <span class="click-target" @click=${this.doPreviousTrack}>PREV</span>
    <span class="click-target" @click=${this.doNextTrack}>NEXT</span>
    <span class="click-target" @click=${this.doPause}>PLAY/PAUSE</span>
    <span>${this.currentPlayTrack?.metadata?.title} (${(this.playCursor?.index ?? -1) + 1} / ${this.currentPlayPlaylist?.entryPaths?.length ?? this.playCursor?.trackCount})</span>
  </div>

  <div>
    <textarea id="search-query-textarea" @input=${this.queryChanged} @keypress=${this.queryKeypress}></textarea>
    <span>
    ${this.completions.map(c => html`
      <span class="click-target" @click=${() => this.acceptQueryCompletion(c)}>
        ${c.byValue ?? c.byCommand?.atomPrefix ?? '<unknown>'}
      </span>
    `)}
    </span>
  </div>
  <div>Database.instance.searchContextEpoch ${Database.instance.searchContextEpoch}</div>
  <div>Database.instance.searchResultsStatus.status ${Database.instance.searchResultsStatus}</div>
  <div>Database.instance.partialSearchResultsAvailable ${Database.instance.partialSearchResultsAvailable}</div>
  <div class="click-target" @click=${this.requestUpdate}>REFRESH</div>
  <recycler-view id="track-list-view"></recycler-view>

  <div style="display: none;">
  ${this.tracksInView.map(track => html`
    <div>${track?.path}</div>
  `)}
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
  }
}
