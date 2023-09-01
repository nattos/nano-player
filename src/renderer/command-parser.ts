import * as utils from '../utils';

export interface CommandSpec {
  name: string;
  desc: string;
  chipLabel?: string;
  atomPrefix?: string;
  hasNegativeAtom?: boolean;
  enterAtomContext?: boolean;
  canExitAtomContext?: boolean;
  executeOnAutoComplete?: boolean;
  argSpec: CommandArgSpec[];
  func?: CommandFunc;
  suggestEnabledFunc?: CommandValueFunc;
  valueFunc?: CommandValueFunc;
  beginPreviewFunc?: CommandFunc;
  cancelPreviewFunc?: CommandFunc;
  chipLabelFunc?: CommandChipLabelFunc;
}

export interface CommandArgSpec {
  isString?: boolean;
  isNumber?: boolean;
  oneof?: string[];
  oneofProvider?: () => string[];
  subcommands?: CommandSpec[];
  isRepeated?: boolean;
}

export interface CandidateCompletion {
  isComplete: boolean;
  resolvedArgs?: CommandResolvedArg[];
  byValue?: string;
  byCommand?: CommandSpec;
  forCommand?: CommandSpec;
  suffixFragment?: string;
  resultQuery?: string;
}

export type CommandFunc = (command: CommandSpec, args: CommandResolvedArg[]) => void;
export type CommandValueFunc = (command: CommandSpec, args: CommandResolvedArg[]) => any;
export type CommandChipLabelFunc = (command: CommandSpec, args: CommandResolvedArg[]) => string|undefined;

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

  public parse(fullQuery: string, addExecuteAsCompletion = false): CandidateCompletion[] {
    const [completions, executeFuncs] = this.parseQuery(fullQuery, false);
    if (addExecuteAsCompletion && executeFuncs) {
      for (const executeFunc of executeFuncs) {
        completions.push(executeFunc);
      }
    }
    return completions;
  }

  public execute(fullQuery: string): boolean {
    const executeFuncs = this.parseQuery(fullQuery, true)[1];
    if (executeFuncs.length === 0) {
      return false;
    }
    for (const executeFunc of executeFuncs) {
      if (executeFunc.forCommand && executeFunc.resolvedArgs) {
        executeFunc.forCommand.func?.(executeFunc.forCommand, executeFunc.resolvedArgs);
      }
    }
    return true;
  }

  private parseQuery(fullQuery: string, execute: boolean): [completions: CandidateCompletion[], executeFuncs: CandidateCompletion[]] {
    const [rest, newHead, completions, resolvedArgs, forCommand] = this.parseArgs(fullQuery, '', undefined, [{subcommands: this.commands}]);
    console.log(`rest: ${rest} completions: [${completions.map(c => c.resultQuery ?? c.byValue ?? c.byCommand?.atomPrefix ?? '<unknown>').join('|')}]`);

    const executeFuncs: CandidateCompletion[] = [];
    if (resolvedArgs) {
      for (const resolvedArg of resolvedArgs) {
        const command = resolvedArg.subcommand;
        if (command) {
          executeFuncs.push({
            isComplete: true,
            resolvedArgs: command.args,
            byCommand: forCommand,
            forCommand: command.command,
            suffixFragment: '',
            resultQuery: fullQuery,
          });
        }
      }
    }
    return [completions, executeFuncs];
  }

  private parseArgs(rest: string, head: string, forCommand: CommandSpec|undefined, argSpec: CommandArgSpec[]): [
      rest: string|undefined,
      head: string,
      candidateCompletions: Array<CandidateCompletion>,
      resolvedArgs: CommandResolvedArg[]|undefined,
      forCommand: CommandSpec|undefined] {
    const consumedArgs = new Set<CommandArgSpec>();
    let nonRepeatedCount = argSpec.reduce((a, arg) => a + (arg.isRepeated ? 0 : 1), 0);
    let hasRepeated = argSpec.some(arg => arg.isRepeated);

    const candidateCompletions:Array<CandidateCompletion> = [];
    const candidateCompletionsSet = new Set<CommandSpec|string>();
    const resolvedArgs: CommandResolvedArg[] = [];

    let isFirst = true;
    let newHead = head;
    let lastForCommand = forCommand;
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
            const useCompletions: boolean = subcommand?.suggestEnabledFunc?.(subcommand, []) ?? true;
            if (subcommand.atomPrefix === undefined) {
              isMatch = true;
            } else {
              const isColonAtom = subcommand.atomPrefix.endsWith(':');
              if (rest.startsWith(subcommand.atomPrefix)) {
                const candidateRest = rest.slice(subcommand.atomPrefix.length);
                const nextIsWhitespace = candidateRest.length === 0 || candidateRest.trimStart().length != candidateRest.length;
                if (isColonAtom || nextIsWhitespace) {
                  newHead += subcommand.atomPrefix;
                  [newHead, rest] = sliceTrimStartAcc(newHead, candidateRest);
                  isMatch = true;
                }
              } else if (useCompletions) {
                if (subcommand.atomPrefix.startsWith(rest)) {
                  if (!candidateCompletionsSet.has(subcommand)) {
                    const [suffixFragment, resultQuery] =
                        makeFragments(newHead, !isColonAtom, subcommand.atomPrefix, rest.length);
                    candidateCompletionsSet.add(subcommand);
                    candidateCompletions.push({
                        isComplete: false,
                        byCommand: subcommand,
                        suffixFragment: suffixFragment,
                        resultQuery: resultQuery,
                        forCommand: forCommand,
                    });
                  }
                }
              }
            }
            if (isMatch) {
              // Recurse.
              // console.log(`Matched subcommand: ${subcommand.name}`);
              const [newRest, parsedNewHead, subCandidateCompletions, subResolvedArgs, parsedForCommand] =
                  this.parseArgs(rest, newHead, subcommand, subcommand.argSpec);
              if (newRest === undefined || subResolvedArgs === undefined) {
                return [undefined, '', subCandidateCompletions, undefined, undefined];
              }
              resolvedArgs.push({
                subcommand: {
                  command: subcommand,
                  args: subResolvedArgs,
                }
              });
              rest = newRest;
              newHead = parsedNewHead;
              lastForCommand = parsedForCommand ?? lastForCommand;
              if (subcommand.canExitAtomContext === false) {
                return ['', '', [], resolvedArgs, parsedForCommand ?? subcommand ?? forCommand];
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
        const oneofValues = arg.oneofProvider?.() ?? arg.oneof;
        if (oneofValues && !isMatch) {
          if (oneofValues.indexOf(token) >= 0) {
            isMatch = true;
            // console.log(`Matched oneof arg ${token}`);
            resolvedArgs.push({ oneofValue: token });
          } else {
            for (const oneof of oneofValues) {
              if (!oneof.startsWith(rest)) {
                continue;
              }
              if (!candidateCompletionsSet.has(oneof)) {
                candidateCompletionsSet.add(oneof);
                const [suffixFragment, resultQuery] =
                    makeFragments(newHead, true, oneof, rest.length);
                candidateCompletions.push({
                    isComplete: false,
                    byValue: oneof,
                    suffixFragment: suffixFragment,
                    resultQuery: resultQuery,
                    forCommand: forCommand,
                });
              }
            }
          }
        }
        if (arg.isNumber && !isMatch) {
          const intValue = utils.parseIntOr(token);
          if (intValue !== undefined) {
            // console.log(`Matched number arg ${token}`);
            resolvedArgs.push({ intValue: intValue });
            isMatch = true;
          } else {
            if (rest.length === 0) {
              if (!candidateCompletionsSet.has('<int>')) {
                candidateCompletionsSet.add('<int>');
                candidateCompletions.push({
                    isComplete: false,
                    byValue: '<int>',
                    forCommand: forCommand,
                });
              }
            }
          }
        }
        if (arg.isString && !isMatch) {
          if (token.length > 0) {
            // console.log(`Matched string arg ${token}`);
            resolvedArgs.push({ stringValue: token });
            isMatch = true;
          } else {
            if (!candidateCompletionsSet.has('<string>')) {
              candidateCompletionsSet.add('<string>');
              candidateCompletions.push({
                  isComplete: false,
                  byValue: '<string>',
                  forCommand: forCommand,
              });
            }
          }
        }
        if (isMatch) {
          newHead += token;
          [newHead, rest] = sliceTrimStartAcc(newHead, rest.slice(token.length));
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
      // console.log(`Incomplete context: ${rest}`);
      return [undefined, head, candidateCompletions, undefined, undefined];
    }
    return [rest, newHead, [], resolvedArgs, lastForCommand];
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
      const argValue = arg.stringValue ?? arg.oneofValue;
      if (!argValue) {
        throw Error(`Arg expected a string.`);
      }
      return argValue;
    };
  }

  public static resolveIntegerArg(): CommandArgResolverFunc {
    return (arg: CommandResolvedArg) => {
      const argValue = arg.intValue;
      if (argValue === undefined) {
        throw Error(`Arg expected an integer.`);
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

  public static bindValueFunc(func: Function, thisValue: object, ...resolvers: CommandArgResolverFunc[]): CommandValueFunc {
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
      return thisBoundFunc(...resolvedArgs);
    };
  }

  public static bindChipLabelFunc(func: Function, thisValue: object, ...resolvers: CommandArgResolverFunc[]): CommandChipLabelFunc {
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
      return thisBoundFunc(...resolvedArgs);
    };
  }
}

function makeFragments(head: string, needsSpace: boolean, nextToken: string, nextTokenSplit: number) {
  let [fragment, suffixFragment] = sliceAt(nextToken, nextTokenSplit);
  if (needsSpace && head.trimEnd().length === head.length) {
    if (nextTokenSplit === 0) {
      suffixFragment = ' ' + suffixFragment;
    }
  }
  const resultQuery = head + fragment + suffixFragment;
  return [suffixFragment, resultQuery];
}

function sliceTrimStartAcc(head: string, str: string): [head: string, tail: string] {
  const [newHead, newTail] = sliceTrimStart(str);
  return [head + newHead, newTail];
}

function sliceTrimStart(str: string): [head: string, tail: string] {
  const newTail = str.trimStart();
  const newHead = str.slice(0, str.length - newTail.length);
  return [newHead, newTail];
}

function sliceAt(str: string, index: number): [head: string, tail: string] {
  return [str.slice(0, index), str.slice(index)];
}
