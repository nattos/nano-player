declare module 'JSInterpreter';
export as namespace JSInterpreter;


export type JSValue = JSObject|boolean|number|string|undefined|null;

export interface JSObject {
  getter: () => any; // ??
  setter: (any) => void; // ??
  properties: object;
  proto: any;
}

export default class Interpreter {
  static REGEXP_MODE: number;

  constructor(code: string);

  appendCode(code: string): void;
  step(): boolean;
  run(): boolean;
  get value(): JSValue;

  get globalObject(): JSObject;
  nativeToPseudo(nativeObj: any): JSValue;
  createNativeFunction(nativeFunc: Function, isConstructor?: boolean): JSObject;
  getProperty(obj: JSValue, name: JSValue): JSValue|undefined;
  hasProperty(obj: JSObject, name: JSValue): boolean;
  setProperty(obj: JSValue, name: JSValue, value: JSValue, opt_descriptor?: any): JSObject|undefined;
}
