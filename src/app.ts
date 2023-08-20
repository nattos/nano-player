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
import { Database, SortContext } from './database';
import { MediaIndexer } from './media-indexer';
import { TrackCursor } from './track-cursor';
import { CmdSettingsGroupCommands, CmdSortTypes, getCommands } from './app-commands';

RecyclerView; // Necessary, possibly beacuse RecyclerView is templated?

@customElement('nano-app')
export class NanoApp extends LitElement {
  static instance?: NanoApp;

  static styles = css`
  `;

  @query('#search-query-textarea') searchQueryTextarea!: HTMLTextAreaElement;
  @query('#audio-player') audioElement!: HTMLAudioElement;
  @query('#track-list-view') trackListView!: RecyclerView<TrackView, Track>;
  private readonly trackViewHost: TrackViewHost;
  readonly commandParser = new CommandParser(getCommands(this));

  constructor() {
    super();
    const thisCapture = this;
    this.trackViewHost = {
      doPlayTrackView(trackView) {
        thisCapture.doPlayTrack(trackView.index, trackView.track);
      },
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

      MediaIndexer.instance.start();
    });
  }

  @action
  private queryChanged() {
    Database.instance.setSearchQuery(this.searchQueryTextarea.value);
    this.completions = this.commandParser.parse(this.searchQueryTextarea.value);
  }

  @action
  private queryKeypress(e: KeyboardEvent) {
    console.log(e);
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();

      const result = this.commandParser.execute(this.searchQueryTextarea.value);
      if (result) {
        this.searchQueryTextarea.value = '';
        this.queryChanged(); // HACK!!!
      }
    }
  }

  @action
  doLibraryPathsCmd(cmd: CmdSettingsGroupCommands) {}

  @action
  async doReindexLibrary() {
    for (const libraryPath of Database.instance.getLibraryPaths()) {
      if (libraryPath.directoryHandle === undefined) {
        continue;
      }
      // TODO: Centralize permission handling.
      // TODO: Deal with API.
      const permissionResult = await (libraryPath.directoryHandle as any)?.requestPermission();
      if (permissionResult !== 'granted') {
        continue;
      }
      MediaIndexer.instance.queueFileHandle(libraryPath.directoryHandle);
    }
  }

  @observable isPlaying = false;
  @observable currentPlayTrack: Track|null = null;
  private playCursor?: TrackCursor;
  private playOpQueue = new utils.OperationQueue();

  @action
  doPlaySelected() {
  }

  @action
  doPlayTrack(atIndex: number, track: Track|undefined) {
    this.playOpQueue.push(async () => {
      // TODO: Verify track matches.
      await this.movePlayCursor(0, atIndex);
      this.setPlayState(true);
    });
  }

  private async movePlayCursor(delta: number, absPos?: number) {
    if (!this.playCursor) {
      this.playCursor = Database.instance.cursor('library', this.trackViewCursor?.sortContext ?? 'index', {});
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

    const secondResults = this.playCursor.peekRegion(0, 1);
    let foundTrack: Track|undefined;
    if (secondResults.updatedResultsPromise) {
      const secondFetch = await secondResults.updatedResultsPromise;
      for (const track of secondFetch.results) {
        foundTrack = track;
        break;
      }
    } else {
      for (const track of secondResults.dirtyResults) {
        foundTrack = track;
        break;
      }
    }
    runInAction(() => {
      console.log(`currentPlayTrack: ${foundTrack?.path}`);
      this.currentPlayTrack = foundTrack ?? null;
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
        sortContext = 'title';
        break;
      case CmdSortTypes.Artist:
        sortContext = 'artist';
        break;
      case CmdSortTypes.Genre:
        sortContext = 'genre';
        break;
      case CmdSortTypes.Album:
        sortContext = 'album';
        break;
      case CmdSortTypes.LibraryOrder:
        sortContext = 'index';
        break;
    }
    if (sortContext && this.trackViewCursor) {
      this.trackViewCursor.sortContext = sortContext;
      this.updateTrackDataInViewport();
    }
    if (sortContext && this.playCursor) {
      this.playCursor.sortContext = sortContext;
    }
  }

  @action
  doPlaylistAddSelected(playlistName: string) {
  }

  private renderAutorunDisposer = () => {};
  private renderAutorunDirty = true;
  private renderIsInRender = false;
  private renderAutorunResult = html``;

  private trackViewCursor?: TrackCursor;
  @observable tracksInView: Track[] = [];
  tracksInViewBaseIndex = 0;

  @observable completions: CandidateCompletion[] = [];

  @action
  private updateTrackDataInViewport() {
    if (!this.trackViewCursor) {
      this.trackViewCursor = Database.instance.cursor('auto', 'index', {});
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

    this.tracksInView = Array.from(dirtyResults);
    this.tracksInViewBaseIndex = peekMin;
    this.trackListView?.rangeUpdated(peekMin, peekMax);
    if (updatedResultsPromise) {
      updatedResultsPromise.then(action((updatedResults) => {
        console.log("Track results updated async");
        this.tracksInView = Array.from(updatedResults.results);
        this.tracksInViewBaseIndex = peekMin;
        this.trackListView?.rangeUpdated(peekMin, peekMax);
        if (updatedResults.count !== undefined) {
          this.trackListView.totalCount = updatedResults.count;
        }
      }));
    }
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

  @observable loadedDirectory?: FileSystemDirectoryHandle;
  @observable loadedDirectoryName = '';
  @observable loadedFile?: FileSystemFileHandle;
  @observable loadedFileName = '';

  @action
  async selectDirectory() {
    const fileHandle = await (window as any).showDirectoryPicker() as FileSystemDirectoryHandle;
    this.loadedDirectory = fileHandle;
    this.loadedDirectoryName = fileHandle.name;
  }

  @action
  async requestDirectoryPermission() {
    console.log(await (this.loadedDirectory as any).queryPermission());
    console.log(await (this.loadedDirectory as any).requestPermission());
  }

  @action
  async indexDirectory() {
    if (!this.loadedDirectory) {
      return;
    }
    await Database.instance.addLibraryPath(this.loadedDirectory);
    MediaIndexer.instance.queueFileHandle(this.loadedDirectory);
  }

  @action
  async selectFile() {
    const fileHandles = await (window as any).showOpenFilePicker() as FileSystemFileHandle[];
    const fileHandle = fileHandles[0];
    this.loadedFile = fileHandle;
    this.loadedFileName = fileHandle?.name ?? '';
  }

  @action
  async requestFilePermission() {
    console.log(await (this.loadedFile as any).queryPermission());
    console.log(await (this.loadedFile as any).requestPermission());
  }

  @action
  async resolveFileInDirectory() {
    if (!this.loadedFile || !this.loadedDirectory) {
      return;
    }
    const resolved = await this.loadedDirectory?.resolve(this.loadedFile);
    console.log(resolved);
    if (!resolved) {
      return;
    }
    const fileName = resolved.splice(resolved.length - 1)[0];
    let directoryHandle = this.loadedDirectory;
    for (const directoryName of resolved) {
      directoryHandle = await directoryHandle.getDirectoryHandle(directoryName);
    }
    const fileHandle = await directoryHandle.getFileHandle(fileName);
    this.loadedFile = fileHandle;
    this.loadedFileName = fileHandle?.name ?? '';
  }

  @action
  async loadFileToAudio() {
    if (!this.loadedFile || !this.audioElement) {
      return;
    }
    this.audioElement.src = URL.createObjectURL(await this.loadedFile.getFile());
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
  <div><span @click=${this.selectDirectory}>SELECT</span> <span @click=${this.requestDirectoryPermission}>ALLOW</span> <span>${this.loadedDirectoryName}</span> <span @click=${this.indexDirectory}>INDEX</span></div>
  <div><span @click=${this.selectFile}>SELECT</span> <span @click=${this.requestFilePermission}>ALLOW</span> <span>${this.loadedFileName}</span> <span @click=${this.resolveFileInDirectory}>RESOLVE</span></div>
  <div><audio id="audio-player" controls></audio> <span @click=${this.loadFileToAudio}>LOAD</span></div>

  <div>
    <textarea id="search-query-textarea" @input=${this.queryChanged} @keypress=${this.queryKeypress}></textarea>
    <span>
      ${this.completions.map(c => c.byValue ?? c.byCommand?.atomPrefix ?? '<unknown>').join('|')}
    </span>
  </div>
  <div>Database.instance.searchContextEpoch ${Database.instance.searchContextEpoch}</div>
  <div>Database.instance.searchResultsStatus.status ${Database.instance.searchResultsStatus}</div>
  <div>Database.instance.partialSearchResultsAvailable ${Database.instance.partialSearchResultsAvailable}</div>
  <div @click=${this.requestUpdate}>REFRESH</div>
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
    };
    this.trackListView!.dataGetter = (index) => this.tracksInView.at(index - this.tracksInViewBaseIndex);
    this.trackListView.ready();
  }
}
