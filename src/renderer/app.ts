import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, query, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { action, autorun, runInAction, observable, observe, makeObservable } from 'mobx';
import { RecyclerView } from './recycler-view';
import { CandidateCompletion, CommandParser, CommandResolvedArg, CommandSpec } from './command-parser';
import * as utils from '../utils';
import * as constants from './constants';
import * as fileUtils from './file-utils';
import * as environment from './environment';
import { ListPos, TrackView, TrackViewHost } from './track-view';
import { TrackGroupView, TrackGroupViewHost } from './track-group-view';
import { TrackInsertMarkerView } from './track-insert-marker-view';
import './simple-icon-element';
import { Track, SortContext } from './schema';
import { Database, ListPrimarySource, ListSource, QueryToken, QueryTokenAtom, SearchResultStatus } from './database';
import { MediaIndexer } from './media-indexer';
import { TrackCursor } from './track-cursor';
import { CmdLibraryCommands, CmdLibraryPathsCommands, CmdSortTypes, getCommands } from './app-commands';
import { Playlist, PlaylistManager } from './playlist-manager';
import { Selection, SelectionMode } from './selection';
import { ImageCache } from './ImageCache';
import { getBrowserWindow } from './renderer-ipc';
import { PathsDirectoryHandle, createUrl, handlesFromDataTransfer, revokeUrl, showDirectoryPicker } from './paths';
import { FileStatus, TranscodeOperation, TranscodeOutput, UserConfirmationState } from './transcode-operation';
import { PointerDragOp } from './pointer-drag-op';
import { adoptCommonStyleSheets } from './stylesheets';

RecyclerView; // Necessary, possibly beacuse RecyclerView is templated?

enum Overlay {
  AlbumArt = 'album-art',
  DragDropAccept = 'drag-drop-accept',
  TranscodeBegin = 'transcode-begin',
}

enum DragDropState {
  NotStarted,
  Success,
  Failure,
}

@customElement('nano-app')
export class NanoApp extends LitElement {
  static instance?: NanoApp;
  someStyles?: CSSStyleSheet;

  @query('#query-input') queryInputElement!: HTMLInputElement;
  @query('#player-seekbar') playerSeekbarElement!: HTMLElement;
  @query('#track-list-view') trackListView!: RecyclerView<TrackView, Track, TrackGroupView, Track>;
  @property() overlay?: Overlay;
  @property() windowActive = true;
  @observable dragDropState = DragDropState.NotStarted

  private didReadyTrackListView = false;
  readonly selection = new Selection<Track>();
  private previewMoveDelta = 0;
  private previewMoveIsAbsolute = false;
  @observable private previewMoveInsertPos: number|null = null;
  private queuedPlaybackSource?: ListSource;
  private queuedPlaybackLocation?: number;
  private readonly trackViewHost: TrackViewHost;
  private readonly trackGroupViewHost: TrackGroupViewHost;
  @observable private trackViewBottomShadeAlpha = 0.0;

  private readonly playbackPlayedQueue: Array<{index: number, track: Track}> = [];
  private readonly playbackQueue: Array<{index: number, track: Track}> = [];
  private readonly playbackSkipQueue: Array<{index: number, track: Track}> = [];
  private playbackQueueWasForward = true;
  private playbackStopAfter = false;

  readonly commandParser = new CommandParser(getCommands(this));

  private readonly audioElement = new Audio();

  constructor() {
    super();
    NanoApp.instance = this;
    const thisCapture = this;

    this.audioElement.addEventListener('ended', this.onAudioEnded.bind(this));
    this.audioElement.addEventListener('error', this.onAudioError.bind(this));
    this.audioElement.addEventListener('loadstart', this.onAudioLoadStart.bind(this));
    this.audioElement.addEventListener('loadeddata', this.onAudioLoaded.bind(this));
    this.audioElement.addEventListener('timeupdate', this.onAudioTimeUpdate.bind(this));

    this.trackViewHost = {
      doPlayTrackView(trackView) {
        thisCapture.doPlayTrack(trackView.index, trackView.track);
      },
      doSelectTrackView: this.doSelectTrackView.bind(this),
      doSelectTrackIndex: this.doSelectTrackIndex.bind(this),
      doPreviewMove: action(this.doMoveTrackPreviewMove.bind(this)),
      doAcceptMove: action(this.doMoveTrackAcceptMove.bind(this)),
      doCancelMove: action(this.clearMoveTracksPreview.bind(this)),
      doContextMenu: action(this.onContextMenuTrackView.bind(this)),
      pagePointToListPos: this.pagePointToListPos.bind(this),
    };
    this.trackGroupViewHost = {
      doPlayTrackGroupView(groupView) {
        thisCapture.doPlayTrack(groupView.startIndex, groupView.track);
      },
      doSelectTrackGroupView: this.doSelectTrackGroupView.bind(this),
    };
    this.selection.onSelectionChanged.add(() => {
      this.clearMoveTracksPreview();
      this.updateSelectionInTrackView();
    });
    makeObservable(this);

    const browserWindow = getBrowserWindow();
    if (browserWindow) {
      browserWindow.onDidActiveChange = (active) => this.windowActive = active;
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    adoptCommonStyleSheets(this);

    navigator.mediaSession.setActionHandler('play', this.doPlay.bind(this));
    navigator.mediaSession.setActionHandler('pause', this.doPause.bind(this));
    navigator.mediaSession.setActionHandler('seekbackward', () => {});
    navigator.mediaSession.setActionHandler('seekforward', () => {});
    navigator.mediaSession.setActionHandler('previoustrack', this.doPreviousTrack.bind(this));
    navigator.mediaSession.setActionHandler('nexttrack', this.doNextTrack.bind(this));

    Database.instance.waitForLoad().then(() => {
      const playerPreferences = Database.instance.playerPreferences;
      const loadLocation = playerPreferences.lastPlayedLocation;
      if (loadLocation) {
        this.queuedPlaybackLocation = loadLocation.index ?? undefined;
        this.queuedPlaybackSource = {
          source: loadLocation.playlistKey ? ListPrimarySource.Playlist : ListPrimarySource.Library,
          secondary: loadLocation.playlistKey ?? undefined,
          sortContext: loadLocation.sortContext ?? undefined,
        };
      }

      const updateTracks = () => this.updateTrackDataInViewport();
      observe(Database.instance, 'searchResultsStatus', updateTracks);
      observe(Database.instance, 'searchContextEpoch', updateTracks);
      observe(Database.instance, 'listChangeEpoch', updateTracks);

      observe(this.trackListView, 'viewportMinIndex', updateTracks);
      observe(this.trackListView, 'viewportMaxIndex', updateTracks);
      updateTracks();

      if (this.queuedPlaybackLocation) {
        const toLoad = this.queuedPlaybackLocation;
        this.queuedPlaybackLocation = undefined;
        this.movePlayCursor(0, toLoad, this.resolveCurrentSourceForNewPlayCursor(), environment.isElectron());
      }

      autorun(() => { this.trackListView.insertMarkerPos = this.previewMoveInsertPos ?? undefined; });

      Database.instance.onTrackPathsUpdated.add((paths) => {
        setTimeout(async () => {
          const playingPath = this.currentPlayTrack?.path;
          if (playingPath && paths.includes(playingPath)) {
            this.reloadPlayingTrack();
          }
        });
      });

      autorun(() => { this.loadTrack(this.currentPlayTrack); });
      autorun(() => { this.setLoadedTrackPlaying(this.isPlaying); });

      MediaIndexer.instance.start();

      window.addEventListener('keydown', this.onWindowKeydown.bind(this));
      window.addEventListener('keypress', this.onWindowKeypress.bind(this));
      window.addEventListener('contextmenu', this.onWindowRightClick.bind(this));
      window.addEventListener('drop', this.doDragDropDrop.bind(this));
      window.addEventListener('dragover', this.doDragDropDragOver.bind(this));
      window.addEventListener('dragleave', this.doDragDropDragLeave.bind(this));
    });
  }

  @observable queryInputForceShown = false;
  private requestFocusQueryInput = false;
  private queryPreviewing?: CandidateCompletion = undefined;

  @action
  private doToggleQueryInputField(state?: boolean, initialQuery?: string) {
    this.overlay = undefined;
    const newState = state ?? !this.queryInputForceShown;
    if (newState === this.queryInputForceShown) {
      return;
    }
    this.queryInputForceShown = newState;
    if (this.queryInputForceShown) {
      if (initialQuery !== undefined) {
        if (initialQuery === '') {
          this.doSearchClear();
        }
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

    let backQuery = query.trimEnd();
    if (backQuery.at(backQuery.length - 1) === ':') {
      backQuery = backQuery.substring(0, backQuery.length - 1);
    }
    while (backQuery.length > 0) {
      const lastChar = backQuery[backQuery.length - 1];
      if (lastChar === ':' || lastChar.trim().length === 0) {
        break;
      }
      backQuery = backQuery.substring(0, backQuery.length - 1);
    }
    backQuery = backQuery.trimEnd();

    completions.push({
      isComplete: false,
      byCommand: {
        name: 'back',
        desc: 'back',
        atomPrefix: '←',
        argSpec: [],
      },
      resultQuery: backQuery,
    });
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
    if (completion.resultQuery !== undefined) {
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
    const currentQuery = this.queryInputElement.value;
    const queryIsDefault = !currentQuery || currentQuery.trim() === 'cmd:';
    if ((e.key === '/' || e.key === '?') && queryIsDefault) {
      e.preventDefault();
      this.doToggleQueryInputField(false);
    }
    e.stopPropagation();
  }

  @action
  private queryAreaKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.doToggleQueryInputField(false);
    }
    e.stopPropagation();
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

  private searchAcceptedQuery: QueryToken[] = [];
  private searchPreviewQuery: QueryToken[] = [];
  private prevSearchQuery: QueryToken[] = [];
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
    console.log(`do preview: ${this.searchQueryToString(query)}`);
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
      const newQueryStr = this.searchQueryToString(nextQuery);
      const oldQueryStr = this.searchQueryToString(this.prevSearchQuery);
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

  private searchQueryFromArgs(args: CommandResolvedArg[]): QueryToken[] {
    return Array.from(utils.filterNulllike(args.map(arg => {
      if (arg.subcommand) {
        const subtoken = arg.subcommand.command.valueFunc?.(arg.subcommand.command, arg.subcommand.args) as QueryToken;
        if (subtoken) {
          return subtoken;
        }
      }
      const stringlike = arg.oneofValue ?? arg.stringValue;
      if (stringlike) {
        return {text: stringlike};
      }
      return undefined;
    })));
  }

  private searchQueryToString(queryTokens: QueryToken[]) {
    return queryTokens.map(token => token.atom ? `${token.atom}:${token.text}` : token.text).join(' ');
  }

  searchQueryTokenFromAtomFunc(atom: QueryTokenAtom): (text: string) => QueryToken {
    return (text) => utils.upcast({ text, atom });
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
    const directoryHandle = await showDirectoryPicker();
    if (!directoryHandle) {
      return;
    }

    const libraryPaths = Database.instance.getLibraryPaths();
    let resolvedLibraryPath = undefined;
    let resolvedLibrarySubpath: string[]|undefined = undefined;
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
        const permissionResult = await resolvedLibraryPath.directoryHandle?.requestPermission();
        if (permissionResult === 'granted') {
          MediaIndexer.instance.queueFileHandle(resolvedLibraryPath.directoryHandle, newPath);
        }
      }
    }

    console.log(JSON.stringify(Database.instance.getLibraryPaths()));
  }

  @action
  private onWindowKeydown(e: KeyboardEvent) {
    let captured = true;
    if (e.key === 'Escape') {
      if (this.overlay) {
        this.closeOverlay();
      } else {
        this.doToggleQueryInputField();
      }
    } else if (e.key === 'Enter') {
      this.doPlaySelected();
    } else if (e.key === 'ArrowUp') {
      this.doMoveSelection(-1, e.shiftKey ? SelectionMode.SelectToRange : SelectionMode.Select);
    } else if (e.key === 'ArrowDown') {
      this.doMoveSelection(1, e.shiftKey ? SelectionMode.SelectToRange : SelectionMode.Select);
    } else if (e.key === 'ArrowLeft') {
      this.shiftPlayPosition(-5.00);
    } else if (e.key === 'ArrowRight') {
      this.shiftPlayPosition(5.00);
    } else {
      captured = false;
    }
    if (captured) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  @action
  private onWindowKeypress(e: KeyboardEvent) {
    let captured = true;
    console.log(e);
    const isNoModifier = !e.metaKey && !e.ctrlKey && !e.altKey;
    const isCtrlOption = e.metaKey || e.ctrlKey || e.altKey;
    if (e.key === 'z' && (isNoModifier || isCtrlOption)) {
      this.doPreviousTrack();
    } else if (e.key === 'x' && (isNoModifier || isCtrlOption)) {
      this.doPlay();
    } else if (e.key === 'c' && (isNoModifier || isCtrlOption)) {
      this.doPause();
    } else if (e.key === 'v' && (isNoModifier || isCtrlOption)) {
      this.doStop();
    } else if (e.key === 'b' && (isNoModifier || isCtrlOption)) {
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
  private onWindowRightClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.doToggleQueryInputField(undefined, '');
  }

  @action
  private onContextMenuTrackView(trackView: TrackView) {
    this.selection.select(trackView.index, trackView.track, SelectionMode.SetPrimary);
    if (trackView.selected) {
      this.doToggleQueryInputField(undefined, 'cmd:selection ');
    } else {
      this.doToggleQueryInputField(undefined, '');
    }
  }

  private isInDragDrop = false;

  @action
  private async doDragDropDrop(e: DragEvent) {
    if (this.isInDragDrop) {
      this.overlay = Overlay.DragDropAccept;
      this.isInDragDrop = false;
      this.dragDropState = DragDropState.NotStarted;
      setTimeout(() => {
        if (this.overlay === Overlay.DragDropAccept) {
          this.overlay = undefined;
        }
      }, 1200);
    }

    try {
      e.preventDefault();
      if (!e.dataTransfer?.files) {
        return;
      }
      const fileHandles = await handlesFromDataTransfer(e.dataTransfer);

      for (const fileHandle of fileHandles) {
        console.log(fileHandle);
      }

      const source = this.resolveSource(this.trackViewCursor!.source);
      if (source.source === ListPrimarySource.Playlist) {
        const playlist = source.secondary ? await PlaylistManager.instance.getPlaylist(source.secondary) : undefined;
        if (!playlist) {
          throw new Error('Current playlist not found.');
        }

        const resolvedPaths = await Promise.all(fileHandles.map(handle => Database.instance.resolveInLibraryPaths(handle)));
        if (resolvedPaths.some(entry => !entry.libraryPath || !entry.subpath)) {
          throw new Error('Not all paths could be resolved in library.');
        }
        const allPathPromises = resolvedPaths.map(async (resolvedPath) => {
          if (resolvedPath.handle.kind === 'directory') {
            const directory = resolvedPath.handle as PathsDirectoryHandle;
            const directoryHandle = resolvedPath.handle as PathsDirectoryHandle;
            const resultPaths: string[] = [];
            for await (const subfile of fileUtils.enumerateFilesRec(directoryHandle)) {
              const subpath = await directory.resolve(subfile);
              if (!subpath) {
                continue;
              }
              resultPaths.push(Database.makePath(resolvedPath.libraryPath!.path, resolvedPath.subpath!.concat(subpath)));
            }
            return resultPaths;
          } else {
            return [Database.makePath(resolvedPath.libraryPath!.path, resolvedPath.subpath!)];
          }
        });
        const allPathsToAdd: string[] = Array.from(utils.mapAll(await Promise.all(allPathPromises), (paths) => paths));

        await PlaylistManager.instance.updatePlaylist(playlist.key, playlist.entryPaths.concat(allPathsToAdd));
        // Ensure paths actually exist.
        for (const pathToAdd of utils.filterUnique(allPathsToAdd)) {
          MediaIndexer.instance.updateMetadataForPath(pathToAdd);
        }
      } else {
        const resolvedPaths = await Promise.all(fileHandles.map(handle => Database.instance.resolveInLibraryPaths(handle)));
        const toAdds = [];
        for (const resolvedPath of resolvedPaths) {
          if (resolvedPath.handle.kind === 'file') {
            console.log(`${resolvedPath.handle.name} is a loose file. Ephemeral files not supported yet.`);
            continue;
          }
          const handle = resolvedPath.handle as PathsDirectoryHandle;
          if (!resolvedPath.libraryPath || !resolvedPath.subpath) {
            toAdds.push({
              newLibraryPathFromHandle: handle,
            });
            continue;
          }
          const subpath = resolvedPath.subpath.join('/');
          if (resolvedPath.libraryPath.indexedSubpaths.some(indexed => subpath.startsWith(indexed))) {
            console.log(`${handle.name} already in library.`);
            continue;
          }
          toAdds.push({
            toLibraryPath: resolvedPath.libraryPath,
            subpath: subpath,
          });
        }
        if (toAdds.length === 0) {
          throw new Error('No files updated.');
        }
        for (const toAdd of toAdds) {
          if (toAdd.newLibraryPathFromHandle) {
            console.log(`Adding ${toAdd.newLibraryPathFromHandle.name} as new indexed library path.`);
            const newLibraryPath = await Database.instance.addLibraryPath(toAdd.newLibraryPathFromHandle);
            await Database.instance.setLibraryPathIndexedSubpaths(newLibraryPath.path, ['']);
            MediaIndexer.instance.queueFileHandle(toAdd.newLibraryPathFromHandle);
          } else {
            console.log(`Adding ${toAdd.subpath} as new indexed subpath of ${toAdd.toLibraryPath.path}.`);
            // Fetch the latest incase multiple subpaths are added to the same library path.
            const updatedLibraryPath = Database.instance.findLibraryPath(toAdd.toLibraryPath.path);
            await Database.instance.setLibraryPathIndexedSubpaths(updatedLibraryPath!.path, updatedLibraryPath!.indexedSubpaths.concat(toAdd.subpath));

            (async () => {
              // TODO: Centralize permission handling.
              // TODO: Deal with API.
              const permissionResult = await updatedLibraryPath?.directoryHandle?.requestPermission();
              if (permissionResult === 'granted') {
                MediaIndexer.instance.queueFileHandle(updatedLibraryPath!.directoryHandle!, toAdd.subpath);
              }
            })();
          }
        }
      }

      this.dragDropState = DragDropState.Success;
    } catch (e) {
      console.log(e);
      this.dragDropState = DragDropState.Failure;
    }
  }

  @action
  private doDragDropDragOver(e: DragEvent) {
    if (e.dataTransfer?.files) {
      e.preventDefault();
      // TODO: Consider making overlay stack.
      this.overlay = Overlay.DragDropAccept;
      this.isInDragDrop = true;
      this.dragDropState = DragDropState.NotStarted;
    }
  }

  @action
  private doDragDropDragLeave(e: DragEvent) {
    // TODO: Consider making overlay stack.
    this.overlay = undefined;
    this.isInDragDrop = false;
    this.dragDropState = DragDropState.NotStarted;
  }

  @observable isPlaying = false;
  @observable currentPlayProgress = 0;
  @observable currentPlayProgressFraction = 0;
  @observable.shallow currentPlayTrack: Track|null = null;
  @observable.shallow currentPlayPlaylist: Playlist|null = null;
  @observable currentPlayImageUrl: string|null = null;
  private currentPlayMoveEpoch = 0;
  private currentPlayImageUrlEpoch = 0;
  private playLastDelta = 1;
  private playCursor?: TrackCursor;
  private readonly playOpQueue = new utils.OperationQueue();
  private loadedTrackPath?: string = undefined;
  private loadedTrackMoveEpoch = 0;
  private readonly loadTrackQueue = new utils.OperationQueue();
  private isAudioPlayerLoading = false;
  private readonly audioPlayerStatusChanged = new utils.WaitableFlag();

  @action
  doPlaySelected() {
    const [index, track] = this.selection.primary;
    if (index === undefined) {
      return;
    }
    this.doPlayTrack(index, track);
  }

  @action
  doPlayTrack(atIndex: number, track: Track|undefined) {
    this.playOpQueue.push(async () => {
      // TODO: Verify track matches.
      await this.movePlayCursor(0, atIndex, this.resolveCurrentSourceForNewPlayCursor());
      this.setPlayState(true);
    });
  }

  private resolveCurrentSourceForNewPlayCursor(): ListSource {
    const fromSource: ListSource = {
      source: this.trackViewCursor?.primarySource ?? ListPrimarySource.Auto,
      secondary: this.trackViewPlaylist ?? undefined,
      sortContext: this.trackViewCursor?.sortContext,
    };
    return fromSource;
  }

  @action
  doMoveSelection(delta: number, mode: SelectionMode) {
    const [oldIndex, track] = this.selection.primary;
    let newIndex = (oldIndex ?? 0) + delta;
    newIndex = Math.max(0, Math.min(this.trackViewCursor!.trackCount - 1, newIndex));
    this.selection.select(newIndex, undefined, mode);
    this.trackListView.ensureVisible(newIndex, constants.ENSURE_VISIBLE_PADDING);
  }

  hasSelection(): boolean {
    return this.selection.any;
  }

  pagePointToListPos(pageX: number, pageY: number): ListPos {
    const clientRect = this.trackListView.getBoundingClientRect();
    const maxIndex = Math.max(0, this.trackListView.totalCount - 1);
    const viewportX = pageX - clientRect.left;
    const viewportY = pageY - clientRect.top;
    const fineIndex = this.trackListView.viewportPointToFineTrackIndex(viewportX, viewportY);
    let closestIndex = Math.floor(fineIndex);
    let afterIndex;
    let beforeIndex;
    let isAtStart = false;
    let isAtEnd = false;
    if (closestIndex < 0) {
      closestIndex = 0;
      afterIndex = -1;
      beforeIndex = 0;
      isAtStart = true;
    } else if (closestIndex > maxIndex) {
      closestIndex = maxIndex;
      afterIndex = maxIndex;
      beforeIndex = maxIndex + 1;
      isAtEnd = true;
    } else if (closestIndex > (fineIndex - 0.5)) {
      afterIndex = closestIndex - 1;
      beforeIndex = closestIndex;
    } else {
      afterIndex = closestIndex;
      beforeIndex = closestIndex + 1;
    }
    return {
      afterIndex: afterIndex,
      beforeIndex: beforeIndex,
      closestExistingIndex: closestIndex,
      isAtStart: isAtStart,
      isAtEnd: isAtEnd,
    };
  }

  @action
  doSelectTrackView(trackView: TrackView, mode: SelectionMode) {
    if (!trackView.track) {
      return;
    }
    this.selection.select(trackView.index, trackView.track, mode);
    this.trackViewCursor?.setAnchor?.({ index: trackView.index, path: trackView.track.path });
  }

  @action
  doSelectTrackIndex(index: number, mode: SelectionMode) {
    this.selection.select(index, undefined, mode);
  }

  @action
  doMoveTrackPreviewMove(trackView: TrackView, delta: number, isAbsolute: boolean): void {
    this.previewMoveDelta = isAbsolute ? delta : (this.previewMoveDelta + delta);
    this.previewMoveIsAbsolute = isAbsolute;
    let previewMoveInsertPos: number|undefined = undefined;
    const indicesToMove = Array.from(this.selection.all).sort((a, b) => a - b);
    if (indicesToMove.length > 0) {
      if (isAbsolute) {
        previewMoveInsertPos = this.previewMoveDelta;
      } else if (this.previewMoveDelta > 0) {
        previewMoveInsertPos = indicesToMove[indicesToMove.length - 1] + this.previewMoveDelta + 1;
      } else if (this.previewMoveDelta < 0) {
        previewMoveInsertPos = indicesToMove[0] + this.previewMoveDelta;
      }
    }

    if (previewMoveInsertPos !== undefined) {
      const oldPos = previewMoveInsertPos;
      previewMoveInsertPos = Math.max(0, Math.min(this.trackViewCursor!.trackCount, previewMoveInsertPos));
      const deltaAdjust = oldPos - previewMoveInsertPos;
      this.previewMoveDelta -= deltaAdjust;
    }
    this.previewMoveInsertPos = previewMoveInsertPos ?? null;
    console.log(`move delta: ${this.previewMoveDelta} insert at ${this.previewMoveInsertPos}`);
  }

  @action
  doMoveTrackAcceptMove(trackView: TrackView): void {
    this.doPlaylistMoveSelected(this.previewMoveDelta, this.previewMoveIsAbsolute);
    this.previewMoveDelta = 0;
    this.previewMoveInsertPos = null;
  }

  @action
  clearMoveTracksPreview() {
    this.previewMoveDelta = 0;
    this.previewMoveInsertPos = null;
  }

  @action
  doSelectTrackGroupView(groupView: TrackGroupView, mode: SelectionMode) {
    this.selection.select(groupView.startIndex, groupView.track, SelectionMode.Select);
    this.selection.select(groupView.endIndex, undefined, SelectionMode.SelectToRange);
    this.selection.select(groupView.startIndex, groupView.track, SelectionMode.SetPrimary);
    if (groupView.track) {
      this.trackViewCursor?.setAnchor?.({ index: groupView.startIndex, path: groupView.track.path });
    }
  }

  @action
  async doShowSelectionInFileBrowser() {
    const index = this.selection.all.at(0);
    if (index === undefined) {
      return;
    }
    const track = await this.fetchTrack(index);
    if (!track) {
      return;
    }
    const browserWindow = getBrowserWindow();
    browserWindow?.showFileInBrowser('/' + track.filePath);
  }

  @action
  async doSelectionTranscode() {
    const tracks = Array.from(utils.filterNulllike(await this.fetchSelectionTracks()));
    this.transcodeOperation = new TranscodeOperation(Array.from(utils.filterNulllike(tracks.map(entry => entry.track))));
    this.overlay = Overlay.TranscodeBegin;
    setTimeout(() => {
      if (this.transcodeCodeInputElement) {
        this.transcodeCodeInputElement.value = 'filePathChangeExt(fileName, \'mp3\')';
        this.transcodeUpdateCode();
      }
    });
  }

  @action
  async doSelectionPlayNext() {
    const selection = await this.fetchSelectionTracks();
    for (const entry of selection) {
      const index = entry.index;
      const track = entry.track;
      if (track === undefined) {
        continue;
      }
      this.playbackQueue.push({index, track});
    }
  }

  @action
  async doSelectionSkipPlayback() {
    const selection = await this.fetchSelectionTracks();
    for (const entry of selection) {
      const index = entry.index;
      const track = entry.track;
      if (track === undefined) {
        continue;
      }
      this.playbackSkipQueue.push({index, track});
    }
  }

  @action
  doSetStopAfterSelection() {
    this.playbackStopAfter = true;
    this.doSelectionPlayNext();
  }

  // Fetches a single track by index from the track view context.
  async fetchTrack(index: number): Promise<Track|undefined> {
    const op = this.trackViewCursor!.peekRegion(index, index, true);
    let results = op.dirtyResults;
    if (op.updatedResultsPromise) {
      results = await op.updatedResultsPromise;
    }
    if (results.rebasedStartIndex !== index) {
      throw new Error('Interrupted.');
    }
    for (const track of results.results) {
      return track;
    }
    return undefined;
  }

  async fetchSelectionTracks(): Promise<Array<{index: number, track: Track|undefined}>> {
    const pathPromises = [];
    for (const index of this.selection.all) {
      pathPromises.push((async () => utils.upcast({index: index, track: await this.fetchTrack(index)}))());
    }
    return await Promise.all(pathPromises);
  }

  private updateAnchorForTrackView() {
    const orderedTrackViews = this.trackListView.elementsInView.sort((a, b) => a.index - b.index);
    const index = Math.floor(orderedTrackViews.length / 2) || 0;
    const trackView = orderedTrackViews.at(index);
    if (trackView && trackView.track) {
      this.trackViewCursor?.setAnchor?.({ index: trackView.index, path: trackView.track.path });
    }
  }

  private updateSelectionInTrackView() {
    const [primaryIndex, primaryTrack] = this.selection.primary;
    const playIndex = this.playCursor?.anchor?.index;
    const isPlayingContext = this.isShowingPlayCursorContext();
    for (const trackView of this.trackListView.elementsInView) {
      const index = trackView.index;
      trackView.selected = this.selection.has(index);
      trackView.highlighted = index === primaryIndex;
      trackView.playing = isPlayingContext && index === playIndex;
    }
  }
  
  private isShowingPlayCursorContext(): boolean {
    const isListViewPlaylist = this.trackViewCursor?.source?.source === ListPrimarySource.Playlist;
    const isPlayPlaylist = this.playCursor?.source?.source === ListPrimarySource.Playlist;
    const secondaryMatches = (this.trackViewCursor?.source?.secondary ?? this.trackViewPlaylist ?? undefined) === this.playCursor?.source?.secondary;
    return isListViewPlaylist === isPlayPlaylist && (!isPlayPlaylist || secondaryMatches);
  }

  private async movePlayCursor(delta: number, absPos?: number, fromSource?: ListSource, loadTrack: boolean = true) {
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

    if (absPos !== undefined) {
      this.playbackSkipQueue.splice(0);
    }

    let didPlaybackDequeue = false;
    let effectiveDelta = delta;
    if (absPos === undefined && delta >= 0 && this.playbackQueue.length > 0) {
      if (!this.playbackQueueWasForward) {
        const entry = this.playbackQueue.shift()!;
        this.playbackPlayedQueue.push(entry);
      }
      if (this.playbackQueue.length > 0) {
        didPlaybackDequeue = true;
        const entry = this.playbackQueue.shift()!;
        this.playbackPlayedQueue.push(entry);
        absPos = entry.index;
        effectiveDelta = 0;
        this.playbackQueueWasForward = true;
      }
    } else if (absPos === undefined && delta < 0 && this.playbackPlayedQueue.length > 0) {
      if (this.playbackQueueWasForward) {
        const entry = this.playbackPlayedQueue.pop()!;
        this.playbackQueue.unshift(entry);
      }
      if (this.playbackPlayedQueue.length > 0) {
        didPlaybackDequeue = true;
        const entry = this.playbackPlayedQueue.pop()!;
        this.playbackQueue.unshift(entry);
        absPos = entry.index;
        effectiveDelta = 0;
        this.playbackQueueWasForward = false;
      }
    }
    if (!didPlaybackDequeue) {
      this.playbackQueue.splice(0);
      this.playbackPlayedQueue.splice(0);
      this.playbackQueueWasForward = true;
      this.playbackStopAfter = false;
    }
    console.log(this.playbackQueue);
    console.log(this.playbackPlayedQueue);

    const firstResults = this.playCursor.peekRegion(0, 0);
    if (firstResults.updatedResultsPromise) {
      await firstResults.updatedResultsPromise;
    }
    let nextIndex: number;
    if (absPos === undefined) {
      nextIndex = this.playCursor.index + effectiveDelta;
    } else {
      nextIndex = Math.max(0, Math.min(this.playCursor.trackCount, absPos)) + effectiveDelta;
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

    if (foundTrack) {
      const toPlayIndex = this.playCursor.index!;
      const skipIndex = utils.indexOf(this.playbackSkipQueue, entry => entry.index === toPlayIndex);
      if (skipIndex >= 0) {
        this.playbackSkipQueue.splice(skipIndex, 1);
        await this.movePlayCursor(delta, undefined, fromSource, loadTrack);
        return;
      }
    }

    let fromPlaylist: Playlist|undefined = undefined;
    const resolvedSource = this.resolveSource(this.playCursor.source);
    if (resolvedSource.source === ListPrimarySource.Playlist && resolvedSource.secondary) {
      fromPlaylist = await PlaylistManager.instance.getPlaylist(resolvedSource.secondary);
    }
    runInAction(() => {
      console.log(`currentPlayTrack: ${foundTrack?.path}`);
      if (loadTrack) {
        this.currentPlayTrack = foundTrack ?? null;
      }
      this.currentPlayPlaylist = fromPlaylist ?? null;
      this.currentPlayMoveEpoch++;
      const trackViewSource = this.resolveSource(this.trackViewCursor!.source);
      if (foundTrack && trackViewSource.source === resolvedSource.source && trackViewSource.secondary === resolvedSource.secondary) {
        this.selection.select(nextIndex, foundTrack, SelectionMode.SetPrimary);
        this.trackListView.ensureVisible(nextIndex, constants.ENSURE_VISIBLE_PADDING);
      }
      Database.instance.playerPreferences.lastPlayedLocation = {
        playlistKey: resolvedSource.secondary ?? null,
        sortContext: resolvedSource.sortContext ?? null,
        index: nextIndex,
      };
      this.audioSeekOp?.dispose();
    });

    this.loadPlayingTrackImage();
  }

  private async reloadPlayingTrack() {
    await this.reanchorPlayCursor();
    this.loadPlayingTrackImage();
  }

  private loadPlayingTrackImage() {
    const foundTrack = this.currentPlayTrack;

    let didLoadImage = false;
    const loadImageUrlEpoch = ++this.currentPlayImageUrlEpoch;
    setTimeout(action(() => {
      if (this.currentPlayImageUrlEpoch === loadImageUrlEpoch && !didLoadImage) {
        this.currentPlayImageUrl = null;
      }
    }));
    if (foundTrack && foundTrack.coverArt) {
      const loadArtOp = (async () => {
        const url = await ImageCache.instance.getImageUrl(foundTrack.coverArt!);
        if (this.currentPlayImageUrlEpoch === loadImageUrlEpoch) {
          runInAction(() => {
            this.currentPlayImageUrl = url ?? null;
          });
          didLoadImage = true;
        }
      })();
    }
  }

  private async reanchorPlayCursor() {
    const oldAnchor = this.playCursor?.anchor;
    if (!oldAnchor && this.currentPlayTrack) {
      this.playCursor?.setAnchor({index: 0, path: this.currentPlayTrack.path});
    }
    const updatedResults = await this.playCursor?.peekRegion(0, 0)?.updatedResultsPromise;
    if (updatedResults) {
      if (updatedResults.rebasedDelta !== undefined) {
        this.playbackQueue.splice(0);
        this.playbackPlayedQueue.splice(0);
        this.playbackSkipQueue.splice(0);
        this.playbackQueueWasForward = true;
        this.updateTrackDataInViewport();
      }
      const tracks = Array.from(updatedResults.results ?? []);
      const track = tracks.at(0);
      if (track && track.path === this.currentPlayTrack?.path) {
        runInAction(() => {
          this.currentPlayTrack = track;
        });
      }
    }
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

  private shiftPlayPosition(deltaSeconds: number) {
    runInAction(() => {
      if (this.audioElement.duration > 0) {
        const pos = this.audioElement.currentTime + deltaSeconds;
        this.audioElement.currentTime = pos;
        this.currentPlayProgress = pos;
        this.currentPlayProgressFraction = pos / this.audioElement.duration;
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
  doAutoNextTrack() {
    if (this.playbackStopAfter && this.playbackQueue.length === 0) {
      this.playbackStopAfter = false;
      this.doStop();
      return;
    }
    this.doNextTrack();
  }

  @action
  doSetStopAfter() {
    this.playbackStopAfter = true;
  }

  @action
  doFocusPlayingTrack() {
    const anchor = this.playCursor?.anchor;
    if (anchor === undefined || !this.currentPlayTrack) {
      return;
    }
    this.selection.select(anchor.index, this.currentPlayTrack, SelectionMode.SetPrimary);
    this.trackListView.ensureVisible(anchor.index, constants.ENSURE_VISIBLE_PADDING);
    this.trackViewCursor?.setAnchor?.({ index: anchor.index, path: anchor.path });
  }

  @action
  async doSortList(sortType: CmdSortTypes) {
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
    if (this.trackViewCursor!.primarySource !== ListPrimarySource.Playlist) {
      this.trackViewSortContext = sortContext;
      this.updateTrackDataInViewport();
    } else {
      if (sortContext === undefined) {
        return;
      }
      const playlistKey = this.resolveSource(this.trackViewCursor!.source).secondary;
      if (playlistKey === undefined) {
        return;
      }
      await PlaylistManager.instance.updatePlaylistWithCallback(playlistKey, (allEntries) => {
        allEntries.sort((a, b) => {
          const keyA = Database.getSortKeyForContext(a, sortContext!) ?? '';
          const keyB = Database.getSortKeyForContext(b, sortContext!) ?? '';
          return keyA.localeCompare(keyB);
        });
        return allEntries.map(track => track.path);
      });
    }
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
    this.trackViewPlaylist = null;
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
      const permissionResult = await libraryPath.directoryHandle?.requestPermission();
      if (permissionResult !== 'granted') {
        continue;
      }
      for (const subpath of libraryPath.indexedSubpaths) {
        MediaIndexer.instance.queueFileHandle(libraryPath.directoryHandle, subpath);
      }
    }
  }

  isPlaylistContext(): boolean {
    return this.trackViewCursor!.primarySource === ListPrimarySource.Playlist;
  }

  @action
  async doPlaylistShow(playlistArgStr: string) {
    const playlist = await this.resolvePlaylistArg(playlistArgStr);
    if (playlist ===  undefined) {
      return;
    }
    runInAction(() => {
      console.log(playlist.entryPaths.join(', '));
      this.trackViewPlaylist = playlist.key;
      this.trackViewCursor!.primarySource = ListPrimarySource.Playlist;
      this.updateTrackDataInViewport();
    });
  }

  @action
  async doPlaylistAddSelected(playlistArgStr: string) {
    let playlist = await this.resolvePlaylistArg(playlistArgStr);
    if (playlist === undefined) {
      const toCreate = playlistArgStr.trim();
      if (!toCreate) {
        return;
      }
      const newEntry = Database.instance.addPlaylist(toCreate);
      console.log(`Created ${newEntry.name} : ${newEntry.key}`);
      playlist = await PlaylistManager.instance.getPlaylist(newEntry.key);
    }
    if (playlist === undefined) {
      return;
    }

    const pathPromises: Array<Promise<string>> = [];
    for (const index of this.selection.all) {
      pathPromises.push((async () => {
        const peek = await this.fetchTrack(index);
        return peek!.path;
      })());
    }
    const paths: string[] = await Promise.all(pathPromises);
    const newEntries = Array.from(playlist.entryPaths).concat(paths);
    await PlaylistManager.instance.updatePlaylist(playlist.key, newEntries);

    console.log(playlist.entryPaths.join(', '));

    const playlistKey = playlist.key;
    runInAction(() => {
      this.trackViewPlaylist = playlistKey;
      this.trackViewCursor!.primarySource = ListPrimarySource.Playlist;
      this.updateTrackDataInViewport();
    });
  }

  @action
  async doPlaylistRemoveSelected() {
    if (this.trackViewPlaylist === null) {
      return;
    }
    const playlist = await PlaylistManager.instance.getPlaylist(this.trackViewPlaylist);
    if (playlist === undefined) {
      return;
    }

    const indicesToRemove = Array.from(this.selection.all).sort((a, b) => a - b).reverse();
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
  async doPlaylistMoveSelected(delta: number, isAbsolute: boolean) {
    const playlistKey = this.resolveSource(this.trackViewCursor!.source).secondary;
    if (playlistKey === undefined) {
      return;
    }
    const toMoveIndexes = this.selection.all;
    if (toMoveIndexes.length === 0) {
      return;
    }
    toMoveIndexes.sort((a, b) => a - b);
    const minIndex = toMoveIndexes[0];
    const maxIndex = toMoveIndexes[toMoveIndexes.length - 1];
    let insertAbsPos: number|undefined = undefined;
    if (isAbsolute) {
      if (delta <= minIndex) {
        insertAbsPos = delta;
      } else if (delta >= maxIndex) {
        insertAbsPos = delta - toMoveIndexes.length;
      } else {
        insertAbsPos = delta;
        for (const movedIndex of toMoveIndexes) {
          if (movedIndex > delta) {
            break;
          }
          insertAbsPos--;
        }
      }
    }

    let insertMin = 0;
    let insertMax = 0;
    toMoveIndexes.reverse();
    await PlaylistManager.instance.updatePlaylistWithCallback(playlistKey, (allEntries) => {
      const newPaths = allEntries.map(track => track.path);
      const toReinsert: string[] = [];
      for (const index of toMoveIndexes) {
        const removed = newPaths.splice(index, 1).at(0);
        if (removed === undefined) {
          continue;
        }
        toReinsert.push(removed);
      }
      toReinsert.reverse();
      let insertIndex;
      if (insertAbsPos != undefined) {
        insertIndex = insertAbsPos;
      } else if (delta <= 0) {
        insertIndex = Math.max(0, Math.min(newPaths.length, minIndex + delta));
      } else {
        insertIndex = Math.max(0, Math.min(newPaths.length, maxIndex - toReinsert.length + 1 + delta));
      }
      insertMin = insertIndex;
      insertMax = insertIndex + toReinsert.length - 1;
      return newPaths.slice(0, insertIndex).concat(toReinsert).concat(newPaths.slice(insertIndex));
    });
    this.selection.select(insertMin, undefined, SelectionMode.Select);
    this.selection.select(insertMax, undefined, SelectionMode.SelectToRange);
  }

  @action
  async doPlaylistNew(playlistName: string) {
    const newEntry = Database.instance.addPlaylist(playlistName);
    console.log(`Created ${newEntry.name} : ${newEntry.key}`);
    // this.trackViewPlaylist = newEntry.key;
    // this.trackViewCursor!.primarySource = ListPrimarySource.Playlist;
    // this.updateTrackDataInViewport();
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

  @action
  closeOverlay() {
    this.overlay = undefined;
  }

  private overlayStopPropagation(e: Event) {
    e.stopPropagation();
  }

  @action
  showAlbumArtOverlay() {
    this.overlay = Overlay.AlbumArt;
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

  @action
  private updateViewForScroll(top: number, contentHeight: number, viewportHeight: number) {
    const bottom = top + viewportHeight;
    const fromBottom = contentHeight - bottom;
    this.trackViewBottomShadeAlpha = Math.max(0, Math.min(1, fromBottom / 300));
  }

  @observable.shallow private transcodeOperation: TranscodeOperation|null = null;
  @query('#transcode-code-input') transcodeCodeInputElement?: HTMLInputElement;

  @action
  private transcodeUpdateCode() {
    if (!this.transcodeOperation) {
      return;
    }
    this.transcodeOperation.code = this.transcodeCodeInputElement?.value ?? '';
  }

  @action
  private transcodeToggleConfirm(transcodeOutput: TranscodeOutput) {
    const canAccept = this.transcodeCanAcceptOutput(transcodeOutput);
    const oldState = transcodeOutput.userOptions.userConfirmation;
    let newState: UserConfirmationState;
    switch (oldState) {
      default:
      case UserConfirmationState.Default:
        newState = canAccept ? UserConfirmationState.Accepted : UserConfirmationState.Rejected;
        break;
      case UserConfirmationState.Accepted:
        newState = UserConfirmationState.Rejected;
        break;
      case UserConfirmationState.Rejected:
        newState = UserConfirmationState.Default;
        break;
    }
    transcodeOutput.userOptions.userConfirmation = newState;
  }

  @action
  private transcodeToggleAllConfirm() {
    if (!this.transcodeOperation) {
      return;
    }
    const allOutputs = this.transcodeOperation.outputs;
    const acceptableOutputs = allOutputs.filter(output => this.transcodeCanAcceptOutput(output));
    const cannotAcceptOutputs = allOutputs.filter(output => !this.transcodeCanAcceptOutput(output));
    const allAccepted = acceptableOutputs.every(output => output.userOptions.userConfirmation === UserConfirmationState.Accepted);
    const allRejected = allOutputs.every(output => output.userOptions.userConfirmation === UserConfirmationState.Rejected);
    for (const output of acceptableOutputs) {
      output.userOptions.userConfirmation =
          allAccepted ? UserConfirmationState.Rejected :
          allRejected ? UserConfirmationState.Default :
          UserConfirmationState.Accepted;
    }
    for (const output of cannotAcceptOutputs) {
      output.userOptions.userConfirmation =
          allRejected ? UserConfirmationState.Default :
          UserConfirmationState.Rejected;
    }
  }

  private transcodeCanAcceptOutput(transcodeOutput: TranscodeOutput) {
    const canAccept =
        transcodeOutput.outputFileStatus === FileStatus.CanCreate ||
        transcodeOutput.outputFileStatus === FileStatus.ExistsCanOverwrite;
    return canAccept;
  }

  private renderAutorunDisposer = () => {};
  private renderAutorunDirty = true;
  private renderIsInRender = false;
  private renderAutorunResult = html``;

  @observable trackViewPlaylist: string|null = null;
  private trackViewSortContext = SortContext.Index;
  private trackViewCursor?: TrackCursor;
  @observable.shallow tracksInView: Array<Track|undefined> = [];
  tracksInViewBaseIndex = 0;

  @observable.shallow completions: CandidateCompletion[] = [];

  @action
  private updateTrackDataInViewport() {
    if (!this.trackViewCursor) {
      this.trackViewCursor = Database.instance.cursor(ListPrimarySource.Auto, undefined, undefined);
      this.trackViewCursor.onCachedTrackInvalidated.add(() => {
        setTimeout(async () => {
          await this.reanchorPlayCursor();
          this.updateTrackDataInViewport();
        });
      });
    }

    if (this.queuedPlaybackSource) {
      const loadLocation = this.queuedPlaybackSource;
      this.queuedPlaybackSource = undefined;
      if (loadLocation.source === ListPrimarySource.Playlist && loadLocation.secondary) {
        this.trackViewCursor.primarySource = ListPrimarySource.Playlist;
        this.trackViewPlaylist = loadLocation.secondary;
      } else {
        this.trackViewSortContext = loadLocation.sortContext ?? this.trackViewSortContext;
      }
    }

    const blockSize = constants.LIST_VIEW_PEEK_LOOKAHEAD;
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
      this.reanchorPlayCursor();
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
      newSource.secondary = newSource.secondary ?? this.trackViewPlaylist ?? undefined;
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

  private async loadTrack(track: Track|undefined|null) {
    this.loadTrackQueue.push(() => this.loadTrackInner(track));
  }

  @action
  private async loadTrackInner(track: Track|undefined|null) {
    if (!track || (track.path === this.loadedTrackPath && this.currentPlayMoveEpoch === this.loadedTrackMoveEpoch)) {
      return;
    }
    this.loadedTrackPath = track.path;
    this.loadedTrackMoveEpoch = this.currentPlayMoveEpoch;

    const sourceKey = Database.getPathSourceKey(track.path);
    const filePath = Database.getPathFilePath(track.path);
    const libraryPath = Database.instance.findLibraryPath(sourceKey);
    if (!libraryPath) {
      return;
    }
    // TODO: Centralize permission handling.
    // TODO: Deal with API.
    const permissionResult = await libraryPath.directoryHandle?.requestPermission();
    if (permissionResult !== 'granted') {
      return;
    }
    try {
      const file = await utils.getSubpathFile(libraryPath.directoryHandle, filePath);
      if (this.audioElement.src) {
        await this.waitAudioElementSettled();
        const toRevoke = this.audioElement.src;
        this.audioElement.srcObject = null;
        revokeUrl(toRevoke);
      }
      if (!file) {
        return;
      }
      const blobUrl = await createUrl(file);
      this.audioElement.src = blobUrl;
      this.setLoadedTrackPlaying(this.isPlaying);
      MediaIndexer.instance.updateMetadataForPath(track.path);
    } catch (e) {
      console.error(e);
      try {
        this.audioElement.srcObject = null;
      } catch (e) {
        console.error(e);
      }
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
    this.doAutoNextTrack();
  }

  private onAudioLoadStart() {
    this.isAudioPlayerLoading = true;
    this.audioPlayerStatusChanged.set();
  }

  private onAudioLoaded() {
    this.isAudioPlayerLoading = false;
    this.audioPlayerStatusChanged.set();
  }

  private onAudioError() {
    this.isAudioPlayerLoading = false;
    this.audioPlayerStatusChanged.set();
    this.movePlayCursor(this.playLastDelta);
  }

  private async waitAudioElementSettled() {
    while (this.isAudioPlayerLoading) {
      await this.audioPlayerStatusChanged.wait();
    }
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

  private audioSeekOp?: PointerDragOp;

  @action
  private onAudioStartSeek(e: PointerEvent) {
    if (e.button !== 0) {
      return;
    }
    this.audioSeekOp?.dispose();
    this.audioSeekOp = new PointerDragOp(e, this.playerSeekbarElement, {
      move: this.audioDoSeek.bind(this),
      callMoveImmediately: true,
    });
  }

  private audioDoSeek(e: PointerEvent) {
    const pageX = e.pageX;
    const clientRect = this.playerSeekbarElement.getBoundingClientRect();
    const fraction = (pageX - clientRect.left) / Math.max(1, clientRect.width);
    this.setPlayPosition(fraction);
  }

  renderInner() {
    return html`
<div
    class=${classMap({
      'app': true,
      'window-active': this.windowActive,
      'window-deactive': !this.windowActive,
    })}>
  ${this.renderTitleBar()}
  <div class="tracks-view-area">
    <recycler-view class="tracks-view" id="track-list-view"></recycler-view>
    ${this.renderQueryOverlay()}
    ${this.renderOverlay()}
  </div>

  <div class="player">
    <div class="player-divider">
      <div class="player-top-shade" style=${styleMap({'opacity': this.trackViewBottomShadeAlpha})}></div>
    </div>
    <div
        class="player-artwork click-target"
        style=${styleMap({
          'background-image': this.currentPlayImageUrl ? `url("${this.currentPlayImageUrl}")` : undefined,
        })}
        @click=${this.doFocusPlayingTrack}>
      <div class="player-artwork-expand-overlay">
        <div class="player-artwork-expand-button click-target" @click=${this.showAlbumArtOverlay}>
          <simple-icon icon="search-plus"></simple-icon>
        </div>
      </div>
    </div>
    <div class="player-info">
      <div class="player-title">${this.currentPlayTrack?.metadata?.title}</div>
      <div class="player-artist">${this.currentPlayTrack?.metadata?.artist}</div>
      <div class="player-album">${this.currentPlayTrack?.metadata?.album}</div>
    </div>
    <div class="player-controls">
      <span class="small-button click-target" @click=${this.doPreviousTrack}><div class="small-button-text"><simple-icon icon="step-backward"></simple-icon></div></span>
      <span class="small-button click-target" @click=${this.doPlay}><div class="small-button-text"><simple-icon icon="play"></simple-icon></div></span>
      <span class="small-button click-target" @click=${this.doPause}><div class="small-button-text"><simple-icon icon="pause"></simple-icon></div></span>
      <span class="small-button click-target" @click=${this.doStop}><div class="small-button-text"><simple-icon icon="stop"></simple-icon></div></span>
      <span class="small-button click-target" @click=${this.doNextTrack}><div class="small-button-text"><simple-icon icon="step-forward"></simple-icon></div></span>
      <span class="small-button click-target" @click=${() => {this.doToggleQueryInputField();}}><div class="small-button-text"><simple-icon icon="bolt"></simple-icon></div></span>
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

  private renderTitleBar() {
    if (!environment.isElectron()) {
      return html``;
    }
    return html`
<div class="window-title-bar">
  <div class="window-title-text-container">
    <div class="window-title-text-part">${this.currentPlayTrack?.metadata?.title ?? ''}</div>
    <div class="window-title-text-part">${this.trackViewPlaylist ? (PlaylistManager.instance.getPlaylistDirty(this.trackViewPlaylist)?.name ?? 'playlist') : 'library'}</div>
    <div class="window-title-text-part">nano-player</div>
    <div class="window-title-text-part" style="overflow: visible; position: relative; left: -0.75em; display: flex;">
      <simple-icon style="color: inherit; font-size: 18px;" icon=${this.isPlaying ? 'play' : 'bolt'}></simple-icon>
    </div>
  </div>
  <div class="window-title-divider"></div>
</div>
    `;
  }

  private renderOverlay() {
    if (this.overlay === undefined) {
      return html``;
    }
    return html`
<div class="overlay-container" @keypress=${this.overlayStopPropagation} @keydown=${this.overlayStopPropagation}>
  <div class="overlay-underlay" @click=${this.closeOverlay}></div>
  <div class="overlay-content">
    ${this.renderOverlayContent()}
  </div>
</div>
`;
  }

  private renderOverlayContent() {
    if (this.overlay === Overlay.AlbumArt) {
      return html`
<img
    class="overlay-album-art-content"
    alt=""
    src=${this.currentPlayImageUrl}>
</img>
`;
    } else if (this.overlay === Overlay.DragDropAccept) {
      return html`
<div class="screaming-headline-text">
  <div>Drop files to add to ${this.trackViewCursor?.primarySource === ListPrimarySource.Playlist ? 'playlist' : 'library'}</div>
  <div>
    <simple-icon icon=${this.dragDropState === DragDropState.Success ? 'check-circle' : this.dragDropState === DragDropState.Failure ? 'exclamation-circle' : 'bolt'}></simple-icon>
  </div>
</div>
`;
    } else if (this.overlay === Overlay.TranscodeBegin) {
      const transcodeAllUserConfirmation =
          this.transcodeOperation?.outputs?.every(output => output.userOptions.userConfirmation === UserConfirmationState.Accepted) ? UserConfirmationState.Accepted :
          this.transcodeOperation?.outputs?.every(output => output.userOptions.userConfirmation === UserConfirmationState.Rejected) ? UserConfirmationState.Rejected :
          undefined;
      const transcodeAllFileStatus =
          this.transcodeOperation?.outputs?.every(output => output.outputFileStatus === FileStatus.CanCreate) ? FileStatus.CanCreate :
          this.transcodeOperation?.outputs?.every(output => output.outputFileStatus === FileStatus.ExistsCanOverwrite) ? FileStatus.ExistsCanOverwrite :
          this.transcodeOperation?.outputs?.every(output => output.outputFileStatus === FileStatus.ExistsCannotOverwrite) ? FileStatus.ExistsCannotOverwrite :
          undefined;
      const isComplete = this.transcodeOperation?.isComplete;
      const wasAnyError = this.transcodeOperation?.outputs?.some(output => output.userOptions.isError);

      return html`
<div class="dialog">
  <div class="dialog-close-button small-button click-target" @click=${this.closeOverlay}>
    <simple-icon icon="times"></simple-icon>
  </div>
  <div class="dialog-title">Transcode</div>
  <div class="dialog-content">
    <div>MP3</div>
    <div>Bitrate 320kbps CBR</div>
    <div><input id="transcode-code-input" class="code" @input=${this.transcodeUpdateCode} style="width: 60em;height: 10em;"></input></div>
    <div style="display:grid;grid-auto-flow:column;grid-auto-columns:50% 50%;height:0px;flex-grow:1;">
      <div style="overflow:scroll;">
        <div>Input (${1}/${this.transcodeOperation?.inputs?.length})</div>
        <div class="code">${JSON.stringify(this.transcodeOperation?.inputs?.at(0)?.codeInputs, null, 2)}</div>
      </div>
      <div style="overflow:scroll;">
        <div style="position:relative;">
          <div style=${styleMap({
            'position': 'absolute',
            'left': '0',
            'top': '0',
            'bottom': '0',
            'width': `${(this.transcodeOperation?.completionFraction ?? 0) * 100}%`,
            'background-color': isComplete && wasAnyError ? 'red' : 'green',
            'z-index': '0',
          })}}></div>
          <div style="display:flex;align-items:center;position:relative;z-index:1;">
            <div style="flex-grow:1;width:0px;overflow:hidden;text-overflow:ellipsis;">Outputs</div>
            <div>
              <simple-icon
                  class=${classMap({
                      'small-button': true,
                      'click-target': true,
                      'green': transcodeAllUserConfirmation === UserConfirmationState.Accepted,
                      'red': transcodeAllUserConfirmation === UserConfirmationState.Rejected,
                  })}
                  icon=${
                      transcodeAllUserConfirmation === UserConfirmationState.Accepted ? 'check-circle' :
                      transcodeAllUserConfirmation === UserConfirmationState.Rejected ? 'minus-circle' :
                      transcodeAllFileStatus === FileStatus.CanCreate ? 'check-circle' :
                      transcodeAllFileStatus === FileStatus.ExistsCanOverwrite ? 'question-circle' :
                      transcodeAllFileStatus === FileStatus.ExistsCannotOverwrite ? 'exclamation-circle' :
                      'question-circle'
                  }
                  @click=${() => this.transcodeToggleAllConfirm()}
                  >
              </simple-icon>
            </div>
          </div>
        </div>
        <div>
        ${this.transcodeOperation?.error ?
          html`<div class="code">${this.transcodeOperation?.error}</div>` :
          this.transcodeOperation?.outputs?.map(output => html`
          <div style="position:relative;">
            <div style=${styleMap({
              'position': 'absolute',
              'left': '0',
              'top': '0',
              'bottom': '0',
              'width': `${output.userOptions.completionFraction * 100}%`,
              'background-color': output.userOptions.isError ? 'red' : 'green',
              'z-index': '0',
            })}}></div>
            <div style="display:flex;align-items:center;position:relative;z-index:1;">
              <div class="code" style="flex-grow:1;width:0px;overflow:hidden;text-overflow:ellipsis;">${output.error ?? output.outputAbsFilePath}</div>
              <div>
                <simple-icon
                    class=${classMap({
                        'small-button': true,
                        'click-target': true,
                        'green': output.userOptions.userConfirmation === UserConfirmationState.Accepted,
                        'red': output.userOptions.userConfirmation === UserConfirmationState.Rejected,
                    })}
                    icon=${
                        output.userOptions.userConfirmation === UserConfirmationState.Accepted ? 'check-circle' :
                        output.userOptions.userConfirmation === UserConfirmationState.Rejected ? 'minus-circle' :
                        output.outputFileStatus === FileStatus.CanCreate ? 'check-circle' :
                        output.outputFileStatus === FileStatus.ExistsCanOverwrite ? 'question-circle' :
                        output.outputFileStatus === FileStatus.ExistsCannotOverwrite ? 'exclamation-circle' :
                        'question-circle'
                    }
                    @click=${() => this.transcodeToggleConfirm(output)}
                    >
                </simple-icon>
              </div>
            </div>
          </div>
        `)}
        </div>
      </div>
    </div>
    <div class="horizontal-divider"></div>
    <div style="display:flex;justify-content:flex-end;">
      <div
          class="small-button click-target"
          style="width:fit-content;padding:1em 2em;flex-grow:0;"
          @click=${() => this.transcodeOperation!.launchJob()}>
        START
      </div>
    </div>
  </div>
</div>
`;
    }
    return html``;
  }

  private renderQueryOverlay() {
    return html`
<div class=${classMap({
        'query-container': true,
        'hidden': !this.isQueryInputVisible() || this.overlay !== undefined,
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
      <div class="query-input-icon"><simple-icon icon="bolt"></simple-icon></div>
    </div>
    <div class="query-completion-area">
      ${this.completions.map(c => html`
        <div
            class=${classMap({
              'query-completion-chip': true,
              'click-target': true,
              'special': getChipLabel(c) || false,
            })}
            @click=${(e: MouseEvent) => this.onCompletionChipClicked(e, c)}>
          <div class="query-completion-chip-label">${c.byCommand?.atomPrefix === '←' ? html`<simple-icon style="font-size: 120%;" icon="arrow-left"></simple-icon>` : c.byValue ?? c.byCommand?.atomPrefix ?? '<unknown>'}</div>
          <div class="query-completion-chip-tag">${getChipLabel(c)}</div>
        </div>
      `)}
    </div>
  </div>
</div>
    `;
  }

  protected updated(changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>): void {
    super.updated(changedProperties);

    document.title = [
        this.currentPlayTrack?.metadata?.title ?? '',
        this.trackViewCursor?.secondarySource ?? 'library',
        'nano-player'
    ].join(' _ ');

    if (!this.didReadyTrackListView) {
      this.didReadyTrackListView = true;

      this.trackListView.onScrolled = (top: number, contentHeight: number, viewportHeight: number) => {
        this.updateViewForScroll(top, contentHeight, viewportHeight);
      };
      this.trackListView.onUserScrolled = () => {
        this.updateAnchorForTrackView();
      };

      this.trackListView.dataProvider = {
        dataGetter: (index) => this.tracksInView.at(index - this.tracksInViewBaseIndex),
        elementConstructor: () => new TrackView(),
        elementDataSetter: (trackView, index, track) => {
          const playIndex = this.playCursor?.anchor?.index;
          const isListViewPlaylist = this.trackViewCursor?.source?.source === ListPrimarySource.Playlist;
          const isPlayingContext = this.isShowingPlayCursorContext();

          trackView.index = index;
          trackView.track = track;
          trackView.host = this.trackViewHost;

          const [primaryIndex, primaryTrack] = this.selection.primary;
          trackView.selected = this.selection.has(index);
          trackView.highlighted = index === primaryIndex;
          trackView.playing = isPlayingContext && index === playIndex;
          trackView.showReorderControls = isListViewPlaylist;
        },

        groupKeyGetter: (index) => this.tracksInView.at(index - this.tracksInViewBaseIndex)?.generatedMetadata?.groupingKey,
        groupDataGetter: (index) => this.tracksInView.at(index - this.tracksInViewBaseIndex),
        groupElementConstructor: () => new TrackGroupView(),
        groupElementDataSetter: (groupView, startIndex, endIndex, track) => {
          groupView.startIndex = startIndex;
          groupView.endIndex = endIndex;
          groupView.track = track;
          groupView.host = this.trackGroupViewHost;
        },

        insertMarkerConstructor: () => new TrackInsertMarkerView(),
      }
      this.trackListView.ready();
    }

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
