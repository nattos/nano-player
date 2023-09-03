import {} from 'lit/html';
import * as utils from '../utils';
import { Track } from './schema';
import * as babel from '@babel/standalone';
import * as jsinterpreter from 'js-interpreter';

export function createTrackEvaluator(code: string): (track: Track) => string|undefined {
  const evaler = createEvaluator(code);
  if (evaler.error) {
    console.error(evaler.error);
  }
  const func = evaler.func ?? ((params: EvalParams) => utils.upcast<EvalResult>({}));
  return (track: Track) => {
    const result = func({ 'track': track });
    if (typeof result.value === 'string') {
      return result.value;
    }
    return undefined;
  };
}

export type EvalParams = Record<string, object|string|number>;

export interface EvalResult {
  value?: object|string|number;
  error?: string;
}

export interface CompileResult {
  func?: (params: EvalParams) => EvalResult;
  error?: string;
}

export function createEvaluator(code: string): CompileResult {
  try {
    if (code.trim().length === 0) {
      return {};
    }
    jsinterpreter.default.REGEXP_MODE = 1;
    const codeES5 = babel.transform(code, {'presets': ['env']}).code;
    const evaler = new jsinterpreter.default('');
    const compiledAst = evaler.parse_(codeES5);

    const addGlobalFunc = (name: string, func: Function) => {
      const ofunc = evaler.createNativeFunction(func);
      evaler.setProperty(evaler.globalObject, name, ofunc);
    }
    addGlobalFunc('filePathDirectory', utils.filePathDirectory);
    addGlobalFunc('formatIntPadded', utils.formatIntPadded);

    const stringPrototype = evaler.getProperty(evaler.getProperty(evaler.globalObject, 'String'), 'prototype');
    evaler.setProperty(stringPrototype, 'padStart', evaler.createNativeFunction(function (this: jsinterpreter.JSObject, maxLength: number, fillString?: string) { return (this.data as string).padStart(maxLength, fillString); }));
    evaler.setProperty(stringPrototype, 'padEnd', evaler.createNativeFunction(function (this: jsinterpreter.JSObject, maxLength: number, fillString?: string) { return (this.data as string).padEnd(maxLength, fillString); }));

    const func = (params: EvalParams) => {
      try {
        evaler.appendCode(compiledAst);
        for (const [identifier, value] of Object.entries(params)) {
          const ovalue = evaler.nativeToPseudo(value);
          evaler.setProperty(evaler.globalObject, identifier, ovalue);
        }
        evaler.run();
        const result = evaler.value;
        const ret: EvalResult = {};
        if (typeof result === 'string') {
          ret.value = result as string;
        }
        if (typeof result === 'number') {
          ret.value = result as number;
        }
        if (typeof result === 'object') {
          ret.value = evaler.pseudoToNative(result) as object;
        }
        return ret;
      } catch (e) {
        return { error: e?.toString() };
      }
    };
    return { func };
  } catch (e) {
    return { error: e?.toString() };
  }
}
