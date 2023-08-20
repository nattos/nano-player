import * as utils from './utils';

export interface CommandSpec {
  name: string;
  desc: string;
  atomPrefix?: string;
  hasNegativeAtom?: boolean;
  enterAtomContext?: boolean;
  canExitAtomContext?: boolean;
  argSpec: CommandArgSpec[];
  func: CommandFunc;
}

export interface CommandArgSpec {
  isString?: boolean;
  isNumber?: boolean;
  oneof?: string[];
  subcommands?: CommandSpec[];
  isRepeated?: boolean;
}

export interface CandidateCompletion {
  byValue?: string;
  byCommand?: CommandSpec;
}

export type CommandFunc = (command: CommandSpec, args: CommandResolvedArg[]) => void;

export interface CommandResolvedArg {
  intValue?: number;
  stringValue?: string;
  oneofValue?: string;
  subcommand?: CommandResolvedSubcommand;
}

export interface CommandResolvedSubcommand {
  command: CommandSpec;
  args: CommandResolvedArg[];
}

export type CommandArgResolverFunc = (arg: CommandResolvedArg) => any;

export class CommandParser {
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
          const intValue = utils.parseIntOr(token);
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

  public static resolveStringArg(): CommandArgResolverFunc {
    return (arg: CommandResolvedArg) => {
      const argValue = arg.stringValue;
      if (!argValue) {
        throw Error(`Arg expected a string.`);
      }
      return argValue;
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
