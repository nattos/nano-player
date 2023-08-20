import { NanoApp } from "./app";
import { CommandSpec, CommandParser, CommandResolvedArg } from "./command-parser";

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

function executeSubcommandsFunc(command: CommandSpec, args: CommandResolvedArg[]) {
  for (const arg of args) {
    if (arg.subcommand) {
      arg.subcommand.command.func(arg.subcommand.command, arg.subcommand.args);
    }
  }
}

export function getCommands(app: NanoApp) {
  const commands: CommandSpec[] = [
    {
      name: 'Command palette',
      desc: 'Select command to execute.',
      atomPrefix: 'cmd:',
      enterAtomContext: true,
      canExitAtomContext: false,
      func: executeSubcommandsFunc,
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
              func: CommandParser.bindFunc(app.doLibraryPathsCmd, app, CommandParser.resolveEnumArg(CmdSettingsGroupCommands)),
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
              func: CommandParser.bindFunc(app.doSortList, app, CommandParser.resolveEnumArg(CmdSortTypes)),
            },
            {
              // cmd:reindex
              name: 'Reindex library',
              desc: 'Reloads metadata for all tracks in library, and removes missing files.',
              atomPrefix: 'reindex',
              argSpec: [],
              func: app.doReindexLibrary.bind(app),
            },
            {
              // cmd:play-selected
              name: 'Play selected',
              desc: 'Plays selected track.',
              atomPrefix: 'play-selected',
              argSpec: [],
              func: app.doPlaySelected.bind(app),
            },
            {
              // cmd:play
              name: 'Play',
              desc: 'Resumes playback if paused or stopped, or rewinds to the beginning of the current track if already playing.',
              atomPrefix: 'play',
              argSpec: [],
              func: app.doPlay.bind(app),
            },
            {
              // cmd:pause
              name: 'Pause',
              desc: 'Toggles playback play/pause.',
              atomPrefix: 'pause',
              argSpec: [],
              func: app.doPause.bind(app),
            },
            {
              // cmd:stop
              name: 'Stop',
              desc: 'Stops playback, rewinding to the beginning of the current track.',
              atomPrefix: 'stop',
              argSpec: [],
              func: app.doStop.bind(app),
            },
            {
              // cmd:prev
              name: 'Previous',
              desc: 'Moves playback to the previous track.',
              atomPrefix: 'prev',
              argSpec: [],
              func: app.doPreviousTrack.bind(app),
            },
            {
              // cmd:next
              name: 'Next',
              desc: 'Moves playback to the next track.',
              atomPrefix: 'next',
              argSpec: [],
              func: app.doNextTrack.bind(app),
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
