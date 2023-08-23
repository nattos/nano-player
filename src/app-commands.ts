import { NanoApp } from "./app";
import { CommandSpec, CommandParser, CommandResolvedArg } from "./command-parser";
import { PlaylistManager } from "./playlist-manager";

export enum CmdSortTypes {
  Title = 'title',
  Artist = 'artist',
  Genre = 'genre',
  Album = 'album',
  LibraryOrder = 'library-order',
}

export enum CmdSettingsGroupCommands {
  Show = 'show',
}

export enum CmdLibraryPathsCommands {
  Show = 'show',
  Add = 'add',
  AddIndexed = 'add-indexed',
}

export enum CmdLibraryCommands {
  Show = 'show',
  Reindex = 'reindex',
}

function executeSubcommandsFunc(command: CommandSpec, args: CommandResolvedArg[]) {
  for (const arg of args) {
    if (arg.subcommand) {
      arg.subcommand.command.func(arg.subcommand.command, arg.subcommand.args);
    }
  }
}

export function getCommands(app: NanoApp) {
  const playlistNameProvider = () => PlaylistManager.instance.getPlaylistNamesDirty();

  const commands: CommandSpec[] = [
    {
      name: 'Command palette',
      desc: 'Select command to execute.',
      atomPrefix: 'cmd:',
      enterAtomContext: true,
      canExitAtomContext: false,
      func: executeSubcommandsFunc,
      executeOnAutoComplete: true,
      argSpec: [
        {
          subcommands: [
            {
              // cmd:library-paths <show|add|add-indexed>
              name: 'Show library paths',
              desc: 'Opens up library paths settings.',
              atomPrefix: 'library-paths',
              argSpec: [
                {
                  oneof: Object.values(CmdLibraryPathsCommands),
                },
              ],
              executeOnAutoComplete: true,
              func: CommandParser.bindFunc(app.doLibraryPathsCmd, app, CommandParser.resolveEnumArg(CmdLibraryPathsCommands)),
            },
            {
              // cmd:sort <title|artist|genre|album|library-order>
              name: 'Sorts tracks',
              desc: 'Sorts library or playlist by chosen metadata.',
              atomPrefix: 'sort',
              argSpec: [
                {
                  oneof: Object.values(CmdSortTypes),
                },
              ],
              executeOnAutoComplete: true,
              func: CommandParser.bindFunc(app.doSortList, app, CommandParser.resolveEnumArg(CmdSortTypes)),
            },
            {
              // cmd:play-selected
              name: 'Play selected',
              desc: 'Plays selected track.',
              atomPrefix: 'play-selected',
              argSpec: [],
              executeOnAutoComplete: true,
              func: app.doPlaySelected.bind(app),
            },
            {
              // cmd:play
              name: 'Play',
              desc: 'Resumes playback if paused or stopped, or rewinds to the beginning of the current track if already playing.',
              atomPrefix: 'play',
              argSpec: [],
              executeOnAutoComplete: true,
              func: app.doPlay.bind(app),
            },
            {
              // cmd:pause
              name: 'Pause',
              desc: 'Toggles playback play/pause.',
              atomPrefix: 'pause',
              argSpec: [],
              executeOnAutoComplete: true,
              func: app.doPause.bind(app),
            },
            {
              // cmd:stop
              name: 'Stop',
              desc: 'Stops playback, rewinding to the beginning of the current track.',
              atomPrefix: 'stop',
              argSpec: [],
              executeOnAutoComplete: true,
              func: app.doStop.bind(app),
            },
            {
              // cmd:prev
              name: 'Previous',
              desc: 'Moves playback to the previous track.',
              atomPrefix: 'prev',
              argSpec: [],
              executeOnAutoComplete: true,
              func: app.doPreviousTrack.bind(app),
            },
            {
              // cmd:next
              name: 'Next',
              desc: 'Moves playback to the next track.',
              atomPrefix: 'next',
              argSpec: [],
              executeOnAutoComplete: true,
              func: app.doNextTrack.bind(app),
            },
            {
              // cmd:library <show>
              name: 'Main library commands',
              desc: '...',
              atomPrefix: 'library',
              argSpec: [
                {
                  oneof: Object.values(CmdLibraryCommands),
                },
              ],
              executeOnAutoComplete: true,
              func: CommandParser.bindFunc(app.doLibraryCmd, app, CommandParser.resolveEnumArg(CmdLibraryCommands)),
            },
            {
              // cmd:playlist ...
              name: 'Playlist manipulation',
              desc: 'Performs commands on playlists.',
              atomPrefix: 'playlist',
              argSpec: [
                {
                  subcommands: [
                    {
                      // cmd:playlist show <playlist-name>
                      name: 'Opens playlist',
                      desc: 'Selects and displays a playlist in the track view',
                      atomPrefix: 'show',
                      argSpec: [
                        {
                          oneofProvider: playlistNameProvider,
                        },
                      ],
                      executeOnAutoComplete: true,
                      func: CommandParser.bindFunc(app.doPlaylistShow, app, CommandParser.resolveStringArg()),
                    },
                    {
                      // cmd:playlist add-to <playlist-name>
                      name: 'Add to playlist',
                      desc: 'Add selected tracks to a playlist',
                      atomPrefix: 'add-to',
                      argSpec: [
                        {
                          oneofProvider: playlistNameProvider,
                        },
                      ],
                      executeOnAutoComplete: true,
                      func: CommandParser.bindFunc(app.doPlaylistAddSelected, app, CommandParser.resolveStringArg()),
                    },
                    {
                      // cmd:playlist remove
                      name: 'Remove from playlist',
                      desc: 'Remove selected tracks from the current playlist',
                      atomPrefix: 'remove',
                      argSpec: [],
                      executeOnAutoComplete: true,
                      func: CommandParser.bindFunc(app.doPlaylistRemoveSelected, app),
                    },
                    {
                      // cmd:playlist new <playlist-name>
                      name: 'New playlist',
                      desc: 'Creates a new playlist',
                      atomPrefix: 'new',
                      argSpec: [
                        {
                          isString: true,
                        },
                      ],
                      func: CommandParser.bindFunc(app.doPlaylistNew, app, CommandParser.resolveStringArg()),
                    },
                    {
                      // cmd:playlist clear <playlist-name>
                      name: 'Clear playlist',
                      desc: 'Removes all tracks from a playlist',
                      atomPrefix: 'clear',
                      argSpec: [
                        {
                          oneofProvider: playlistNameProvider,
                        },
                      ],
                      executeOnAutoComplete: true,
                      func: CommandParser.bindFunc(app.doPlaylistClear, app, CommandParser.resolveStringArg()),
                    },
                    {
                      // cmd:playlist show <playlist-name>
                      name: 'DEBUG List playlists',
                      desc: '',
                      atomPrefix: 'debug-list',
                      argSpec: [],
                      executeOnAutoComplete: true,
                      func: CommandParser.bindFunc(app.doPlaylistDebugList, app),
                    },
                  ],
                },
              ],
              func: executeSubcommandsFunc,
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
          oneofProvider: playlistNameProvider,
        },
      ],
      executeOnAutoComplete: true,
      func: CommandParser.bindFunc(app.doPlaylistShow, app, CommandParser.resolveStringArg()),
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
              // title:<title>
              name: 'Title',
              desc: 'Filters by title.',
              atomPrefix: 'title:',
              argSpec: [
                {
                  isString: true,
                }
              ],
              func: () => {},
            },
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
  return commands;
}
