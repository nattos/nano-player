import {openDB, deleteDB, IDBPDatabase, IDBPObjectStore, IDBPTransaction} from 'idb';
import {html, css, LitElement, PropertyValueMap} from 'lit';
import {} from 'lit/html';
import {customElement, property, query} from 'lit/decorators.js';
import {styleMap} from 'lit-html/directives/style-map.js';
import {action, autorun, runInAction, observable, observe, makeObservable} from 'mobx';
import {Reader as jsmediatagsReader} from 'jsmediatags';


@customElement('recycler-view')
export class RecyclerView<TElement extends HTMLElement, TData> extends LitElement {
  private static readonly elementCollectCountWaterlevel = 10;

  @query('#scroll-container') scrollContainer!: HTMLElement;
  @query('#content-area') contentArea!: HTMLElement;

  @property() rowHeight = 42;
  @property() totalCount = 100;
  elementConstructor?: () => TElement;
  elementDataSetter?: (element: TElement, data: TData|undefined) => void;
  dataGetter?: (index: number) => TData|undefined;

  @observable viewportMinIndex = 0;
  @observable viewportMaxIndex = 0;

  private didReady = false;
  private elementsDisplayedMap = new Map<number, TElement>();
  private elementFreePool: TElement[] = [];

  constructor() {
    super();
    makeObservable(this);
  }

  ready() {
    if (this.didReady || !this.contentArea || !this.elementConstructor || !this.elementDataSetter || !this.dataGetter) {
      return;
    }
    this.didReady = true;
  }

  rangeUpdated(min: number, max: number) {
    for (let i = min; i <= max; ++i) {
      const element = this.elementsDisplayedMap.get(i);
      if (element === undefined) {
        continue;
      }
      this.elementDataSetter?.(element, this.dataGetter?.(i));
    }
  }

  private ensureElement(index: number): TElement|undefined {
    let element = this.elementsDisplayedMap.get(index);
    if (element !== undefined) {
      return element;
    }
    element = this.elementFreePool.pop();
    if (element === undefined) {
      element = this.elementConstructor?.();
      if (element === undefined) {
        return undefined;
      }
    }
    element.style['position'] = 'absolute';
    element.style['height'] = `${this.rowHeight}px`;
    element.style['top'] = `${this.rowHeight * index}px`;
    this.contentArea.appendChild(element);
    this.elementsDisplayedMap.set(index, element);

    this.elementDataSetter?.(element, this.dataGetter?.(index));
    return element;
  }

  private freeElement(index: number) {
    let element = this.elementsDisplayedMap.get(index);
    if (element === undefined) {
      return;
    }
    this.elementsDisplayedMap.delete(index);
    this.elementFreePool.push(element);
    element.remove();
  }

  @action
  private onScroll() {
    this.updateViewport();
  }

  private updateViewport() {
    const scrollTop = this.scrollContainer!.scrollTop;
    const scrollBottom = scrollTop + this.scrollContainer!.clientHeight;
    const viewportMinIndex = Math.floor(scrollTop / this.rowHeight);
    const viewportMaxIndex = Math.ceil(scrollBottom / this.rowHeight);

    if (this.didReady) {
      for (let i = viewportMinIndex; i < viewportMaxIndex; ++i) {
        this.ensureElement(i);
      }
      const collectWaterlevel = viewportMaxIndex - viewportMinIndex + RecyclerView.elementCollectCountWaterlevel;
      if (this.elementsDisplayedMap.size > collectWaterlevel) {
        // Sweep elements.
        const toCollect = [];
        for (const [index, value] of this.elementsDisplayedMap) {
          if (index < viewportMinIndex || index > viewportMaxIndex) {
            toCollect.push(index);
          }
        }
        for (const index of toCollect) {
          this.freeElement(index);
        }
        console.log(`collected: ${toCollect}`);
      }
    }

    console.log(`viewport: scrollTop: ${scrollTop} scrollBottom: ${scrollBottom} viewportMinIndex: ${viewportMinIndex} viewportMaxIndex: ${viewportMaxIndex} alive-count: ${this.elementsDisplayedMap.size} free-count: ${this.elementFreePool.length}`);

    this.viewportMinIndex = viewportMinIndex;
    this.viewportMaxIndex = viewportMaxIndex;
  }

  override render() {
    return html`
<div id="scroll-container" style="height: 500px; overflow: scroll; position: relative; background-color: beige;" @scroll=${this.onScroll}>
  <div id="content-area" style=${styleMap({'height': `${this.rowHeight * this.totalCount}px`})}">
  </div>
</div>
    `;
  }

  protected updated(changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>): void {
    super.updated(changedProperties);
    this.ready();
    this.updateViewport();
  }
}



interface CommandSpec {
  name: string;
  desc: string;
  atomPrefix?: string;
  hasNegativeAtom?: boolean;
  enterAtomContext?: boolean;
  canExitAtomContext?: boolean;
  argSpec: CommandArgSpec[];
  func: CommandFunc;
}

interface CommandArgSpec {
  isString?: boolean;
  isNumber?: boolean;
  oneof?: string[];
  subcommands?: CommandSpec[];
  isRepeated?: boolean;
}

interface CandidateCompletion {
  byValue?: string;
  byCommand?: CommandSpec;
}

type CommandFunc = (command: CommandSpec, args: CommandResolvedArg[]) => void;

type CommandResolvedFunc = () => void;

interface CommandResolvedArg {
  intValue?: number;
  stringValue?: string;
  oneofValue?: string;
  subcommand?: CommandResolvedSubcommand;
}

interface CommandResolvedSubcommand {
  command: CommandSpec;
  args: CommandResolvedArg[];
}

type CommandArgResolverFunc = (arg: CommandResolvedArg) => any;

class QueryParser {
  public fullQuery: string = '';
  public currentContextFragment: string = '';

  constructor(public readonly commands: CommandSpec[]) {}

  public parse(fullQuery: string): CandidateCompletion[] {
    return this.parseQuery(fullQuery, false)[0];
  }

  public execute(fullQuery: string): boolean {
    return this.parseQuery(fullQuery, true)[1];
  }

  private parseQuery(fullQuery: string, execute: boolean): [completions: CandidateCompletion[], didExecute: boolean] {
    const [rest, completions, resolvedArgs] = this.parseArgs(fullQuery.trim(), [{subcommands: this.commands}]);
    console.log(`rest: ${rest} completions: [${completions.map(c => c.byValue ?? c.byCommand?.atomPrefix ?? '<unknown>').join('|')}]`);

    let didExecute = false;
    if (execute && resolvedArgs) {
      for (const resolvedArg of resolvedArgs) {
        const command = resolvedArg.subcommand;
        if (command) {
          command.command.func(command.command, command.args);
          didExecute = true;
        }
      }
    }
    return [completions, didExecute];
  }

  private parseArgs(rest: string, argSpec: CommandArgSpec[]): [string|undefined,Array<CandidateCompletion>, CommandResolvedArg[]|undefined] {
    const consumedArgs = new Set<CommandArgSpec>();
    let nonRepeatedCount = argSpec.reduce((a, arg) => a + (arg.isRepeated ? 0 : 1), 0);
    let hasRepeated = argSpec.some(arg => arg.isRepeated);

    const candidateCompletions:Array<CandidateCompletion> = [];
    const candidateCompletionsSet = new Set<CommandSpec|string>();
    const resolvedArgs: CommandResolvedArg[] = [];

    let isFirst = true;
    while ((rest.length > 0 || isFirst) && (argSpec.length > consumedArgs.size || hasRepeated)) {
      isFirst = false;
      candidateCompletions.splice(0);
      candidateCompletionsSet.clear();

      let hadAnyArgMatch = false;
      for (const arg of argSpec) {
        if (consumedArgs.has(arg)) {
          continue;
        }

        let isMatch = false;
        if (arg.subcommands) {
          for (const subcommand of arg.subcommands) {
            if (subcommand.atomPrefix === undefined) {
              isMatch = true;
            } else {
              if (rest.startsWith(subcommand.atomPrefix)) {
                const candidateRest = rest.slice(subcommand.atomPrefix.length);
                const isColonAtom = subcommand.atomPrefix.endsWith(':');
                const nextIsWhitespace = candidateRest.length === 0 || candidateRest.trimStart().length != candidateRest.length;
                if (isColonAtom || nextIsWhitespace) {
                  rest = candidateRest.trim();
                  isMatch = true;
                }
              } else {
                if (subcommand.atomPrefix.startsWith(rest)) {
                  if (!candidateCompletionsSet.has(subcommand)) {
                    candidateCompletionsSet.add(subcommand);
                    candidateCompletions.push({byCommand: subcommand});
                  }
                }
              }
            }
            if (isMatch) {
              // Recurse.
              console.log(`Matched subcommand: ${subcommand.name}`);
              const [newRest, subCandidateCompletions, subResolvedArgs] = this.parseArgs(rest, subcommand.argSpec);
              if (newRest === undefined || subResolvedArgs === undefined) {
                return [undefined, subCandidateCompletions, undefined];
              }
              resolvedArgs.push({
                subcommand: {
                  command: subcommand,
                  args: subResolvedArgs,
                }
              });
              rest = newRest;
              if (subcommand.canExitAtomContext === false) {
                return ['', [], resolvedArgs];
              }
              break;
            }
          }
          if (isMatch) {
            if (arg.isRepeated !== true) {
              consumedArgs.add(arg);
            }
            hadAnyArgMatch = true;
            break;
          }
        }

        const token = rest.split(/[\s]+/).at(0) ?? rest;
        if (arg.oneof) {
          if (arg.oneof.indexOf(token) >= 0) {
            isMatch = true;
            console.log(`Matched oneif arg ${token}`);
            resolvedArgs.push({ oneofValue: token });
          } else {
            for (const oneof of arg.oneof) {
              if (!oneof.startsWith(rest)) {
                continue;
              }
              if (!candidateCompletionsSet.has(oneof)) {
                candidateCompletionsSet.add(oneof);
                candidateCompletions.push({byValue: oneof});
              }
            }
          }
        }
        if (arg.isNumber) {
          const intValue = parseIntOr(token);
          if (intValue !== undefined) {
            console.log(`Matched number arg ${token}`);
            resolvedArgs.push({ intValue: intValue });
            isMatch = true;
          } else {
            if (rest.length === 0) {
              if (!candidateCompletionsSet.has('<int>')) {
                candidateCompletionsSet.add('<int>');
                candidateCompletions.push({byValue: '<int>'});
              }
            }
          }
        }
        if (arg.isString) {
          if (rest.length > 0) {
            console.log(`Matched string arg ${token}`);
            resolvedArgs.push({ stringValue: rest });
            isMatch = true;
          } else {
            if (!candidateCompletionsSet.has('<string>')) {
              candidateCompletionsSet.add('<string>');
              candidateCompletions.push({byValue: '<string>'});
            }
          }
        }
        if (isMatch) {
          rest = rest.slice(token.length).trim();
        }
        if (isMatch) {
          if (arg.isRepeated !== true) {
            consumedArgs.add(arg);
          }
          hadAnyArgMatch = true;
          break;
        }
      }
      if (!hadAnyArgMatch) {
        break;
      }
    }
    if (nonRepeatedCount > consumedArgs.size) {
      console.log(`Incomplete context: ${rest}`);
      return [undefined, candidateCompletions, undefined];
    }
    return [rest, [], resolvedArgs];
  }

  public static resolveEnumArg(enumType: object): CommandArgResolverFunc {
    return (arg: CommandResolvedArg) => {
      const argValue = arg.oneofValue || arg.stringValue;
      if (!argValue) {
        throw Error(`Arg expected a ${enumType}.`);
      }
      for (const value of Object.values(enumType)) {
        if (value === argValue) {
          return value;
        }
      }
      throw Error(`${argValue} not found in ${enumType}.`);
    };
  }
  public static bindFunc(func: Function, thisValue: object, ...resolvers: CommandArgResolverFunc[]): CommandFunc {
    const thisBoundFunc = func.bind(thisValue);
    return (command: CommandSpec, args: CommandResolvedArg[]) => {
      if (resolvers.length > args.length) {
        throw Error(`Expected ${resolvers.length} args but got ${args.length}.`);
      }
      const resolvedArgs: any[] = [];
      for (let i = 0; i < resolvers.length; ++i) {
        const resolver = resolvers[i];
        const arg = args[i];
        const resolved = resolver(arg);
        resolvedArgs.push(resolved);
      }
      thisBoundFunc(...resolvedArgs);
    };
  }
}





enum CmdSortTypes {
  Artist = 'artist',
  Genre = 'genre',
  Album = 'album',
  LibraryOrder = 'library-order',
}

enum CmdSettingsGroupCommands {
  Show = 'show',
}


@customElement('track-view')
export class TrackView extends LitElement {
  static styles = css``;

  @property() track?: Track;

  @action
  async clicked() {
    NanoApp.instance?.playTrack(this.track);
  }

  override render() {
    return html`
<div @click=${this.clicked}>TRACK!!!!!! ${this.track?.path} -- ${this.track?.metadata?.artist} -- ${this.track?.metadata?.album} -- ${formatDuration(this.track?.metadata?.duration)}</div>
    `;
  }
}

@customElement('nano-app')
export class NanoApp extends LitElement {
  static instance?: NanoApp;

  static styles = css`
    :host {
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-weight: 300;
    }
  `;

  @property() something = 0;
  @observable observableSomething = 0;
  @query('#search-query-textarea') searchQueryTextarea!: HTMLTextAreaElement;
  @query('#audio-player') audioElement!: HTMLAudioElement;
  @query('#track-list-view') trackListView!: RecyclerView<TrackView, Track>;

  public static init() {}

  private readonly commands: CommandSpec[] = [
    {
      name: 'Command palette',
      desc: 'Select command to execute.',
      atomPrefix: 'cmd:',
      enterAtomContext: true,
      canExitAtomContext: false,
      func: this.executeSubcommandsFunc,
      argSpec: [
        {
          subcommands: [
            {
              // cmd:library-paths show
              name: 'Show library paths',
              desc: 'Opens up library paths settings.',
              atomPrefix: 'library-paths',
              argSpec: [
                {
                  oneof: Object.values(CmdSettingsGroupCommands),
                },
              ],
              func: QueryParser.bindFunc(this.doLibraryPathsCmd, this, QueryParser.resolveEnumArg(CmdSettingsGroupCommands)),
            },
            {
              // cmd:sort <artist|genre|album|library-order>
              name: 'Sorts tracks',
              desc: 'Sorts library or playlist by chosen metadata.',
              atomPrefix: 'sort',
              argSpec: [
                {
                  oneof: Object.values(CmdSortTypes),
                },
              ],
              func: QueryParser.bindFunc(this.doSortList, this, QueryParser.resolveEnumArg(CmdSortTypes)),
            },
            {
              // cmd:reindex
              name: 'Reindex library',
              desc: 'Reloads metadata for all tracks in library, and removes missing files.',
              atomPrefix: 'reindex',
              argSpec: [],
              func: this.doReindexLibrary.bind(this),
            },
            {
              // cmd:play-selected
              name: 'Play selected',
              desc: 'Plays selected track.',
              atomPrefix: 'play-selected',
              argSpec: [],
              func: this.doPlaySelected.bind(this),
            },
            {
              // cmd:play
              name: 'Play',
              desc: 'Resumes playback if paused or stopped, or rewinds to the beginning of the current track if already playing.',
              atomPrefix: 'play',
              argSpec: [],
              func: this.doPlay.bind(this),
            },
            {
              // cmd:pause
              name: 'Pause',
              desc: 'Toggles playback play/pause.',
              atomPrefix: 'pause',
              argSpec: [],
              func: this.doPause.bind(this),
            },
            {
              // cmd:stop
              name: 'Stop',
              desc: 'Stops playback, rewinding to the beginning of the current track.',
              atomPrefix: 'stop',
              argSpec: [],
              func: this.doStop.bind(this),
            },
            {
              // cmd:prev
              name: 'Previous',
              desc: 'Moves playback to the previous track.',
              atomPrefix: 'prev',
              argSpec: [],
              func: this.doPreviousTrack.bind(this),
            },
            {
              // cmd:next
              name: 'Next',
              desc: 'Moves playback to the next track.',
              atomPrefix: 'next',
              argSpec: [],
              func: this.doNextTrack.bind(this),
            },
            // TODO: cmd:stop-after
            // TODO: cmd:repeat <none|playlist|one|selected>
          ],
        }
      ],
    },
    {
      // playlist:<playlist>
      name: 'Open playlist',
      desc: 'Selects specified playlist.',
      atomPrefix: 'playlist:',
      enterAtomContext: true,
      canExitAtomContext: false,
      argSpec: [
        {
          isString: true,
        }
      ],
      func: () => {},
    },
    {
      // <search> <query>...
      name: 'Search',
      desc: 'Filters library or playlist by search terms.',
      func: () => {},
      argSpec: [
        {
          isString: true,
          isRepeated: true,
          subcommands: [
            {
              // artist:<artist>
              name: 'Artist',
              desc: 'Filters by artist.',
              atomPrefix: 'artist:',
              argSpec: [
                {
                  isString: true,
                }
              ],
              func: () => {},
            },
            {
              // genre:<genre>
              name: 'Genre',
              desc: 'Filters by genre.',
              atomPrefix: 'genre:',
              argSpec: [
                {
                  isString: true,
                }
              ],
              func: () => {},
            },
            {
              // album:<album>
              name: 'Album',
              desc: 'Filters by album.',
              atomPrefix: 'album:',
              argSpec: [
                {
                  isString: true,
                }
              ],
              func: () => {},
            },
            {
              // path:<path>
              name: 'File path',
              desc: 'Filters by file path.',
              atomPrefix: 'path:',
              argSpec: [
                {
                  isString: true,
                }
              ],
              func: () => {},
            },
          ],
        },
      ],
    },
  ];
  readonly queryParser = new QueryParser(this.commands);


  constructor() {
    super();
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

      MediaIndexer.instance.start();
    });
  }

  @action
  private queryChanged() {
    Database.instance.setSearchQuery(this.searchQueryTextarea.value);
    this.completions = this.queryParser.parse(this.searchQueryTextarea.value);
  }

  @action
  private queryKeypress(e: KeyboardEvent) {
    console.log(e);
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();

      const result = this.queryParser.execute(this.searchQueryTextarea.value);
      if (result) {
        this.searchQueryTextarea.value = '';
        this.queryChanged(); // HACK!!!
      }
    }
  }

  private executeSubcommandsFunc(command: CommandSpec, args: CommandResolvedArg[]) {
    for (const arg of args) {
      if (arg.subcommand) {
        arg.subcommand.command.func(arg.subcommand.command, arg.subcommand.args);
      }
    }
  }

  @action
  private doLibraryPathsCmd(cmd: CmdSettingsGroupCommands) {}

  @action
  private async doReindexLibrary() {
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

  @action
  private doPlaySelected() {
  }

  @action
  private doPlay() {
  }

  @action
  private doPause() {
  }

  @action
  private doStop() {
  }

  @action
  private doPreviousTrack() {
  }

  @action
  private doNextTrack() {
  }

  @action
  private doSortList(sortType: CmdSortTypes) {
    let sortContext: SortContext|undefined = undefined;
    switch (sortType) {
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
  async playTrack(track: Track|undefined) {
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
    } catch (e) {
      console.error(e);
      this.audioElement.src = '';
    }
  }

  renderInner() {
    return html`
<div>
  <div @click=${action(() => { this.observableSomething = 5; })}>Hello world ${this.something} ${this.observableSomething}</div>

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
    this.trackListView!.elementDataSetter = (trackView, track) => trackView.track = track;
    this.trackListView!.dataGetter = (index) => this.tracksInView.at(index - this.tracksInViewBaseIndex);
    this.trackListView.ready();
  }
}




interface Track {
  path: string;
  fileHandle?: FileSystemFileHandle;
  metadata?: TrackMetadata;
  generatedMetadata?: GeneratedTrackMetadata;
  addedDate: number;
  indexedDate: number;
  indexedAtLastModifiedDate: number;
}

interface TrackMetadata {
  artist?: string;
  album?: string;
  genre?: string;
  trackNumber?: number;
  trackTotal?: number;
  diskNumber?: number;
  diskTotal?: number;
  duration?: number;
  coverArtSummary?: ArtSummary;
}

interface GeneratedTrackMetadata {
  librarySortKey?: string;
}

interface ArtSummary {
  color: string;
}

interface TrackPrefix {
  path: string;
  prefixes: string[];
}

interface SearchTableEntry extends Track {}

interface LibraryPathEntry {
  path: string;
  directoryHandle?: FileSystemDirectoryHandle;
  fileHandle?: FileSystemFileHandle;
}

const INDEXED_PREFIX_LENGTHS = [ 1, 3, 4 ];
const UPDATE_BATCH_SIZE = 1024;
const PARTIAL_SEARCH_BATCH_SIZE = 128;
const DEBUG_RESET_DATABASE = false;
const DEBUG_INSERT_FAKE_DATA = false;
const UPDATE_DELAY_MILLIS = 200;
const PARTIAL_SUMMARY_LENGTH = 1024;
const LIST_VIEW_PEEK_LOOKAHEAD = 128;
const INDEXED_FILES_PATTERN = /^.*\.(mp3|flac|m4a|wav|aif[f]?|mov|mp[e]?g)$/;


type SearchTableName = 'search-table-a'|'search-table-b';
type SearchResultStatus = 'no_query'|'partial'|'ready';
type QueryTokenContext = 'all'|'artist'|'album'|'genre'|'index';
type SortContext = 'artist'|'album'|'genre'|'index';
type UpdateMode = 'create_only'|'upsert'|'update_only';

const ALL_QUERY_TOKEN_CONTEXTS: QueryTokenContext[] = ['all','artist','album','genre','index'];
const ALL_SORT_CONTEXTS: SortContext[] = ['artist','album','genre','index'];
const SORT_CONTEXTS_TO_METADATA_PATH = {
  'artist': 'metadata.artist',
  'album': 'metadata.album',
  'genre': 'metadata.genre',
  'index': 'generatedMetadata.librarySortKey',
};

class Canceled {}

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

class MediaIndexer {
  public static get instance() {
    if (!MediaIndexer.instanceField) {
      MediaIndexer.instanceField = new MediaIndexer();
    }
    return MediaIndexer.instanceField;
  }
  private static instanceField?: MediaIndexer;

  private started = false;
  private readonly toAddQueue = new AsyncProducerConsumerQueue<FileSystemHandle>();
  private readonly toIndexQueue = new AsyncProducerConsumerQueue<string>();
  private readonly audioElement: HTMLAudioElement = new Audio();
  private audioMetadataReadResolvable?: Resolvable<AudioMetadataInfo>;

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
      formatIntPadded(track.metadata?.diskNumber ?? 0, 3),
      formatIntPadded(track.metadata?.trackNumber ?? 0, 3),
      Database.getPathFilePath(track.path), // TODO: Reverse path parts
    ].join('\x00');
    track.generatedMetadata = {
      librarySortKey: sortKey
    };
  }

  private async fileIndexerProc() {
    const flow = new BatchedProducerConsumerFlow<[FileSystemFileHandle, string[], LibraryPathEntry]>(16);
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
          if (!INDEXED_FILES_PATTERN.test(fileName)) {
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
                title: filePathWithoutExtension(file.name),
              }
            };
          } else {
            throw e;
          }
        }

        const audioMetadataInfo = await this.readAudioMetadataInfo(file);
        const duration = audioMetadataInfo?.duration;

        const trackNumberParts = tags?.tags?.track?.split('/');
        const trackNumber = parseIntOr(trackNumberParts?.at(0));
        const trackTotal = parseIntOr(trackNumberParts?.at(1));

        track.metadata = {
          artist: tags?.tags?.artist,
          album: tags?.tags?.album,
          genre: tags?.tags?.genre,
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
      const resultPromise = new Resolvable<AudioMetadataInfo>();
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

interface TrackPositionAnchor {
  index?: number;
  indexRangeMin?: number;
  indexRangeMax?: number;
  path?: string;
  pathRangeMin?: string;
  pathRangeMax?: string;
}

interface TrackUpdatedResults {
  results: Iterable<Track>;
  count?: number;
}

interface TrackPeekResult {
  dirtyResults: Iterable<Track>;
  updatedResultsPromise: Promise<TrackUpdatedResults>|undefined;
}

class TrackCursor {
  private static readonly cachedBlockCount = 64;
  private static readonly blockSize = 128;

  private databaseDirty = true;
  private currentIndex = 0;

  private readonly cachedBlocks = new LruCache<number, Track[]>(TrackCursor.cachedBlockCount);
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

  setAnchor(anchor: TrackPositionAnchor) {
    this.anchor = anchor;
  }

  seek(index: number) {
    this.currentIndex = index;
  }

  async seekToAnchor() {}

  peekRegion(startDelta: number, endDelta: number): TrackPeekResult {
    this.checkDatabaseDirty();

    const startIndex = this.currentIndex + startDelta;
    const endIndex = this.currentIndex + endDelta;
    const startBlock = Math.max(0, TrackCursor.indexToBlock(startIndex));
    const endBlock = TrackCursor.indexToBlock(endIndex);

    const databaseDirty = this.databaseDirty;
    this.databaseDirty = false;

    const missingBlocks: number[] = [];
    const regionBlocks: Array<Track[]|undefined> = [];
    for (let blockNumber = startBlock; blockNumber <= endBlock; ++blockNumber) {
      const cachedBlock = this.cachedBlocks.get(blockNumber);
      if (cachedBlock === undefined) {
        missingBlocks.push(blockNumber);
      }
      regionBlocks.push(cachedBlock);
    }

    const dirtyResultsGenerator = this.tracksFromRegionBlocksGenerator(regionBlocks, startBlock, startIndex, endIndex);

    if (databaseDirty) {
      // TODO: Handle this.databaseDirty better.
      this.cachedBlocks.clear();
    }

    const updateBlocksPromise = missingBlocks.length <= 0 && !databaseDirty ? undefined : (async () => {
      let updatedBlocks = Array.from(regionBlocks);
      if (databaseDirty) {
        // TODO: Handle this.databaseDirty better.
        updatedBlocks = new Array<Track[]|undefined>(updatedBlocks.length);
      }

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

      let updatedTrackCount = undefined;
      if (databaseDirty) {
        updatedTrackCount = await this.database.countTracks({ source: 'auto', sortContext: this.sortContext });
      }

      return {
        results: generator,
        count: updatedTrackCount,
      };
    })();

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

type ListPrimarySource = 'auto'|'library'|'search'|'playlist';

interface ListSource {
  source: ListPrimarySource;
  secondary?: string;
  sortContext?: SortContext;
}

class Database {
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
  private searchQueryUpdateCancel = new Resolvable<void>();

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
          Array.from(mapAll(ALL_QUERY_TOKEN_CONTEXTS,
                (context) => INDEXED_PREFIX_LENGTHS.map(
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

    for (const prefixLength of INDEXED_PREFIX_LENGTHS) {
      function insertForContext(context: QueryTokenContext, prefixArrays: Array<Array<string>>) {
        const prefixesSet = new Set<string>();
        for (const prefixArray of prefixArrays) {
          setAddRange(prefixesSet, prefixArray);
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
      const artistPrefixes = generatePrefixes(track.metadata?.artist);
      const albumPrefixes = generatePrefixes(track.metadata?.album);
      const genrePrefixes = generatePrefixes(track.metadata?.genre);
      const indexPrefixes = generatePrefixes(track.generatedMetadata?.librarySortKey);

      type QueryTokenContext = 'all'|'artist'|'album'|'genre'|'index';
      insertForContext('all', [ pathPrefixes, artistPrefixes, albumPrefixes, genrePrefixes, indexPrefixes ]);
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

      const cancelFlag = new Resolvable<void>();
      this.searchQueryUpdateCancel = cancelFlag;
      this.searchQueryUpdateInFlight = this.updateSearchTable(this.tokenizeQuery(this.nextSearchQuery), cancelFlag);
    })();
  }

  private tokenizeQuery(query: string): string[] {
    return query.split(/\s/).map(token => token.trim().toLocaleLowerCase()).filter(token => token.length > 0);
  }

  private async updateSearchTable(queryTokens: string[], cancelFlag: Resolvable<void>) {
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

  private async updateSearchTableInner(queryTokens: string[], cancelFlag: Resolvable<void>) {
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

    const minPrefixLength = INDEXED_PREFIX_LENGTHS[0];
    const maxPrefixLength = INDEXED_PREFIX_LENGTHS[INDEXED_PREFIX_LENGTHS.length - 1];

    let hasBest = false;
    let bestCount = 0;
    let bestCursorFunc = undefined;
    for (const queryToken of queryTokens) {
      if (queryToken.length < minPrefixLength) {
        continue;
      }
      let prefixLength = Math.min(maxPrefixLength, queryToken.length);
      if (!INDEXED_PREFIX_LENGTHS.includes(prefixLength)) {
        prefixLength = INDEXED_PREFIX_LENGTHS.reduce((a, b) => b >= prefixLength ? a : b > a ? b : a, minPrefixLength);
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

    const searchTableAddFlow = new BatchedProducerConsumerFlow<Track>(UPDATE_BATCH_SIZE);
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
        if (partialSummary.length < PARTIAL_SUMMARY_LENGTH) {
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
          if (!didPublishPartial && findCount >= PARTIAL_SEARCH_BATCH_SIZE) {
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
        track.metadata?.artist?.toLocaleLowerCase()?.includes(token) ||
        track.metadata?.album?.toLocaleLowerCase()?.includes(token) ||
        track.metadata?.genre?.toLocaleLowerCase()?.includes(token) ||
        false
    );
  }

  private async openDatabaseAsync() {
    if (DEBUG_RESET_DATABASE) {
      await deleteDB('data-tables');
    }
    const db = await openDB('data-tables', 1, {
      upgrade: (upgradeDb) => {
      if (!upgradeDb.objectStoreNames.contains('all-tracks')) {
        const allTracksTable = upgradeDb.createObjectStore('all-tracks', { keyPath: 'path' });
        for (const context of ALL_QUERY_TOKEN_CONTEXTS) {
          for (const prefixLength of INDEXED_PREFIX_LENGTHS) {
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

    if (DEBUG_RESET_DATABASE && DEBUG_INSERT_FAKE_DATA) {
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









class Resolvable<T> {
  private resolveFunc = (value: T) => {}
  private rejectFunc = (reason?: any) => {}
  private readonly promiseField: Promise<T>;
  private completedField = false;

  constructor() {
    this.promiseField = new Promise<T>((resolve, reject) => { this.resolveFunc = resolve; this.rejectFunc = reject; });
    this.promiseField.finally(() => {this.completedField = true;});
  }

  get completed(): boolean {
    return this.completedField;
  }

  resolve(value: T) {
    this.resolveFunc(value);
  }

  reject(reason?: any) {
    this.rejectFunc(reason);
  }

  get promise(): Promise<T> {
    return this.promiseField;
  }

  get callable(): (value: T) => void {
    return this.resolveFunc;
  }
}

class WaitableFlag {
  private flag = new Resolvable<void>();

  constructor() {
  }

  async wait() {
    await this.flag.promise;
    this.flag = new Resolvable<void>();
  }

  set() {
    this.flag.resolve();
  }
}



type BatchedConsumerFunc<T> = (produced: T[]) => void | PromiseLike<void>;
type BatchedConsumerThenFunc = () => void | PromiseLike<void>;

class BatchedProducerConsumerFlow<T> {
  private consumerOp: Promise<void>;
  private consumer = multicast<BatchedConsumerFunc<T>>();
  private batchInProduction: T[] = [];

  constructor(public batchSize: number) {
    // Make this starts as an async op so that `then` doesn't complete immediately.
    this.consumerOp = sleep(0);
  }

  consume(consumer: BatchedConsumerFunc<T>) {
    this.consumer.add(consumer);
  }

  produce(value: T) {
    this.batchInProduction.push(value);
    if (this.batchInProduction.length >= this.batchSize) {
      this.flushProduced();
    }
  }

  flushProduced() {
    if (this.batchInProduction.length <= 0) {
      return;
    }
    const batchToConsume = this.batchInProduction;
    this.batchInProduction = [];

    this.consumerThen(async () => {
      await this.consumer(batchToConsume);
    });
  }

  consumerThen(task: BatchedConsumerThenFunc) {
    const oldConsumerOp = this.consumerOp;
    this.consumerOp = oldConsumerOp.then(task);
  }

  async join(abort = false) {
    if (!abort) {
      this.flushProduced();
    }
    await this.consumer;
  }
}

class AsyncProducerConsumerQueue<T> {
  private readonly queued: T[] = [];
  private readonly flag = new WaitableFlag();

  add(value: T) {
    this.queued.push(value);
    this.flag.set();
  }

  addRange(values: T[]) {
    this.queued.push(...values);
    this.flag.set();
  }

  async pop(): Promise<T> {
    while (this.queued.length <= 0) {
      await this.flag.wait();
    }
    return this.queued.splice(0, 1)[0];
  }
}





interface Subscribable<TFunc extends Function> {
  add(handler: TFunc): void;
  remove(handler: TFunc): void;
}

type Multicast<TFunc extends Function> = Subscribable<TFunc> & TFunc;

function multicast<TFunc extends Function>(...handlers: TFunc[]): Multicast<TFunc> {
  handlers = Array.from(handlers);

  const subscribable: Subscribable<TFunc> = {
    add(handler) {
      handlers.push(handler);
    },
    remove(handler) {
      handlers = handlers.filter(h => h !== handler);
    }
  };

  const invoke: TFunc = ((...args: any[]) => {
    let result: any;
    handlers.forEach(handler => result = handler.apply(null, args));
    return result;
  }) as any;
  return merge(invoke, subscribable);
}




class LruCache<TKey, TValue> {
  private readonly values = new Map<TKey, TValue>();

  constructor(public readonly maxEntries: number) {}

  get(key: TKey): TValue|undefined {
    const entry = this.values.get(key);
    if (entry === undefined) {
      return undefined;
    }
    // peek the entry, re-insert for LRU strategy
    this.values.delete(key);
    this.values.set(key, entry);
    return entry;
  }

  put(key: TKey, value: TValue) {
    if (this.values.size >= this.maxEntries) {
      // least-recently used cache eviction strategy
      const keyToDelete = this.values.keys().next().value;
      this.values.delete(keyToDelete);
    }
    this.values.set(key, value);
  }

  clear() {
    this.values.clear();
  }
}






function sleep(delayMillis: number): Promise<void> {
  return new Promise(resolve => { setInterval(resolve, delayMillis); });
}

function parseIntOr(str: string|undefined, defaultValue?: number) {
  if (str === undefined) {
    return defaultValue;
  }
  const result = parseInt(str);
  if (Number.isNaN(result)) {
    return defaultValue;
  }
  return result;
}

function formatDuration(durationSeconds: number|undefined): string {
  if (durationSeconds === undefined) {
    return '';
  }
  const signStr = durationSeconds < 0 ? '-' : '';
  const totalSeconds = Math.trunc(Math.abs(durationSeconds)) || 0;
  const seconds = Math.trunc(totalSeconds % 60) || 0;
  const totalMinutes = Math.trunc(totalSeconds / 60) || 0;
  const minutes = Math.trunc(totalMinutes % 60) || 0;
  const totalHours = Math.trunc(totalMinutes / 60) || 0;
  const hours = totalHours;
  if (hours > 0) {
    return `${signStr}${hours}:${formatIntPadded(minutes, 2)}:${formatIntPadded(seconds, 2)}`;
  }
  return `${signStr}${minutes}:${formatIntPadded(seconds, 2)}`;
}

function formatIntPadded(value: number, minDigits: number): string {
  const signStr = value < 0 ? '-' : '';
  const absValue = Math.abs(value) || 0;
  let str = absValue.toString();
  while (str.length < minDigits) {
    str = '0' + str;
  }
  return str;
}

function filePathWithoutExtension(path: string): string {
  const splitIndex = path.lastIndexOf('.');
  if (splitIndex < 0) {
    return path;
  }
  return path.slice(0, splitIndex);
}

function* mapAll<TIn, TOut>(values: Iterable<TIn>, callback: (value: TIn) => Iterable<TOut>|undefined) {
  for (const value of values) {
    const valueResult = callback(value);
    if (valueResult === undefined) {
      continue;
    }
    for (const result of valueResult) {
      yield result;
    }
  }
}

function setAddRange<T>(set: Set<T>, values: Iterable<T>) {
  for (const value of values) {
    set.add(value);
  }
}

function merge<T1 extends object, T2 extends object>(onto: T1, from: T2): T1 & T2 {
  if (typeof from !== "object" || from instanceof Array) {
      throw new Error("merge: 'from' must be an ordinary object");
  }
  Object.keys(from).forEach(key => (onto as any)[key] = (from as any)[key]);
  return onto as T1 & T2;
}
